// `delivery` — the agent's side of the contract. Approval, change requests and reset are deliberately
// absent: they only come from the user's own prompts (see hooks.ts).
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { changedPaths, defaultBranch, diffStat, headCommit, repoAt, summarizePaths, treeOf, type Repo } from "./git.ts";
import { createStoredContract, loadContract, logDir, updateContract } from "./store.ts";
import {
  addCriterion,
  addNote,
  createContract,
  formatContract,
  phaseOf,
  recordChecks,
  recordEvidence,
  requestReview,
  type CheckRun,
  type Contract,
} from "./state.ts";

const USAGE = `delivery — acceptance-criteria contract for the current branch

  delivery start --ticket <id> --title <title> [--url <url>] [--source <clickup|jira|linear|github|...>] --ac <text> [--ac <text> ...]
  delivery status
  delivery evidence <ACn> <how it is met: where, and what you observed>
  delivery evidence <ACn> --by-checks     the AC is the checks themselves (lint/types/tests/build pass)
  delivery ac <text>                      add a criterion the ticket implies but does not state
  delivery note <kind> <summary>          review material, e.g. kind playwright | agent-review
  delivery review                         request the user's review (all ACs need evidence)
  delivery check                          run the full local checks (only after the user's /approve)
  delivery config                         show the checks that apply to this repository

The user answers a review with /approve or /changes <reason>. Merging is always the user's call.`;

function requireRepo(): Repo {
  const repo = repoAt(process.cwd());
  if (!repo) throw new Error("Not on a branch of a git repository.");
  return repo;
}

function requireContract(repo: Repo): Contract {
  const contract = loadContract(repo);
  if (!contract) throw new Error(`No delivery contract on branch ${repo.branch}. Start one with \`delivery start\`.`);
  return contract;
}

function start(args: string[]): string {
  const { values } = parseArgs({
    args,
    options: {
      ticket: { type: "string" },
      title: { type: "string", default: "" },
      url: { type: "string" },
      source: { type: "string" },
      ac: { type: "string", multiple: true, default: [] },
    },
  });
  const repo = requireRepo();
  if (repo.branch === defaultBranch(repo.top)) {
    throw new Error(`You are on ${repo.branch}. Create a branch for the ticket first; the contract belongs to that branch.`);
  }
  const baseCommit = headCommit(repo.top);
  if (!baseCommit) {
    throw new Error(`${repo.branch} has no commits yet. Make the initial commit (ask the user if it is theirs to make), then create a branch for the ticket.`);
  }
  const contract = createStoredContract(repo, createContract({
    ticket: values.ticket ?? "",
    title: values.title ?? "",
    url: values.url,
    source: values.source,
    branch: repo.branch,
    baseCommit,
    tree: treeOf(repo.top),
    criteria: values.ac ?? [],
  }));
  const config = loadConfig(repo.top);
  return [
    "Contract opened.",
    formatContract(contract, "implementing"),
    `Full checks, blocked until the user approves: ${config.checks.length > 0 ? config.checks.join(" · ") : "none configured"}`,
  ].join("\n");
}

function review(repo: Repo, tree: string): string {
  const next = updateContract(repo, (contract) => requestReview(contract, tree));
  const config = loadConfig(repo.top);
  return [
    "Review requested. Show this to the user and stop; they answer /approve or /changes <reason>.",
    "",
    formatContract(next, "review"),
    "",
    "Changes since the contract started:",
    diffStat(repo.top, next.startTree, tree) || "(diff unavailable)",
    "",
    `Checks to run after approval: ${config.checks.length > 0 ? config.checks.join(" · ") : config.origin === "config" ? "none (configured)" : "none configured"}`,
  ].join("\n");
}

/** The last `lines` lines written to `fd` since `from`, reading at most the final 64 KiB. */
function tailOf(fd: number, from: number, lines: number): string {
  const size = fstatSync(fd).size;
  const start = Math.max(from, size - 64 * 1024);
  const buffer = Buffer.alloc(size - start);
  readSync(fd, buffer, 0, buffer.length, start);
  return buffer.toString("utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

function check(repo: Repo, contract: Contract, tree: string): { text: string; code: number } {
  const phase = phaseOf(contract, tree);
  if (phase === "implementing" || phase === "review") {
    const approvedTree = contract.approval?.tree;
    const why = approvedTree
      ? `The tree changed after approval (${summarizePaths(changedPaths(repo.top, approvedTree, tree))}). Request review again.`
      : "The user has not approved this work yet.";
    return { text: `Checks not run. ${why}`, code: 2 };
  }
  const config = loadConfig(repo.top);
  if (config.checks.length === 0 && config.origin !== "config") {
    return { text: `No checks configured. The user adds {"checks": [...]} to .claude/delivery.json (an empty list means none), or the repository defines lint/typecheck/test/build scripts.`, code: 2 };
  }
  const log = join(logDir(repo), `${repo.branch.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}.log`);
  const fd = openSync(log, "a+", 0o600);
  const runs: CheckRun[] = [];
  const report: string[] = [];
  const { NODE_COMPILE_CACHE: _ownCache, ...checkEnv } = process.env;
  try {
    for (const command of config.checks) {
      writeSync(fd, `$ ${command}\n`);
      const from = fstatSync(fd).size;
      const started = Date.now();
      // Output goes straight to the log, interleaved as the tools wrote it; only a tail reaches the agent.
      // stdin is not a TTY, so watch-by-default runners (vitest) run once.
      const result = spawnSync(command, { cwd: repo.top, shell: true, stdio: ["ignore", fd, fd], env: checkEnv });
      const exitCode = result.error ? 127 : result.status ?? 128;
      writeSync(fd, `\n[exit ${exitCode}${result.signal ? `, ${result.signal}` : ""}]\n\n`);
      const run = { command, exitCode, ms: Date.now() - started };
      runs.push(run);
      report.push(`${exitCode === 0 ? "✓" : "✗"} ${command} (${(run.ms / 1000).toFixed(1)}s)`);
      if (exitCode !== 0) {
        report.push("", result.error ? String(result.error.message) : tailOf(fd, from, 40));
        break;
      }
    }
  } finally {
    closeSync(fd);
  }
  // A check that rewrites files (formatters, codegen, untracked artifacts) changes what was approved.
  const after = treeOf(repo.top);
  if (after !== tree) {
    const paths = summarizePaths(changedPaths(repo.top, tree, after));
    updateContract(repo, (latest) => recordChecks(latest, tree, [...runs, { command: "(checks must not modify files)", exitCode: 1, ms: 0 }], log));
    return {
      text: [
        ...report,
        "",
        `Checks modified files: ${paths}. The approval no longer matches. If these are build artifacts, they belong in .gitignore (ask the user); otherwise request review again.`,
        `Full log: ${log}`,
      ].join("\n"),
      code: 1,
    };
  }
  const next = updateContract(repo, (latest) => recordChecks(latest, tree, runs, log, config.checks.length === 0));
  const passed = next.checks?.passed;
  const footer = passed
    ? "All checks passed on the approved tree. You may push and open the PR."
    : "A check failed. Fixing it is a change: fix, record evidence, then request review again.";
  return { text: [...report, ...(runs.length === 0 ? ["No checks configured for this repository."] : []), "", footer, `Full log: ${log}`].join("\n"), code: passed ? 0 : 1 };
}

function run(argv: string[]): { text: string; code: number } {
  const [command, ...args] = argv;
  if (!command || ["help", "--help", "-h"].includes(command) || args.some((a) => a === "--help" || a === "-h")) {
    return { text: USAGE, code: 0 };
  }
  if (command === "start") return { text: start(args), code: 0 };

  const repo = requireRepo();
  if (command === "config") {
    const config = loadConfig(repo.top);
    return { text: `Checks (${config.origin}): ${config.checks.length > 0 ? config.checks.join(" · ") : "none"}`, code: 0 };
  }
  const contract = requireContract(repo);
  const tree = treeOf(repo.top);
  switch (command) {
    case "status":
      return { text: formatContract(contract, phaseOf(contract, tree)), code: 0 };
    case "evidence": {
      const byChecks = args.includes("--by-checks");
      const [id, ...note] = args.filter((arg) => arg !== "--by-checks");
      if (!id) throw new Error("Usage: delivery evidence <ACn> <note> | delivery evidence <ACn> --by-checks");
      updateContract(repo, (latest) => recordEvidence(latest, id, note.join(" "), tree, byChecks));
      return {
        text: byChecks
          ? `${id.toUpperCase()} will be proven by \`delivery check\` after the user approves (${loadConfig(repo.top).checks.join(" · ") || "no checks configured"}).`
          : `Evidence recorded for ${id.toUpperCase()}.`,
        code: 0,
      };
    }
    case "ac": {
      const next = updateContract(repo, (latest) => addCriterion(latest, args.join(" "), tree));
      return { text: `Added ${next.criteria.at(-1)?.id}; it is shown to the user as added by you.`, code: 0 };
    }
    case "note": {
      const [kind, ...summary] = args;
      updateContract(repo, (latest) => addNote(latest, kind ?? "", summary.join(" "), tree));
      return { text: "Note recorded.", code: 0 };
    }
    case "review":
      return { text: review(repo, tree), code: 0 };
    case "check":
      return check(repo, contract, tree);
    default:
      throw new Error(`Unknown command ${command}.\n\n${USAGE}`);
  }
}

try {
  const { text, code } = run(process.argv.slice(2));
  process.stdout.write(`${text}\n`);
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`delivery: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
