// Claude Code hooks. Each handler does nothing unless a contract applies, and fails open except
// where opening would publish work: a push or PR that cannot be verified is denied.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { changedPaths, commonDirAt, headTree, repoAt, summarizePaths, treeOf, worktreeOf, type Repo } from "./git.ts";
import { judgeWork, skipSession, type Work } from "./judge.ts";
import { checkKeys, fullCheckOf, located, publishAction, publishOf, segments, touchesStore, USER_COMMAND, USER_COMMAND_ANYWHERE, writesFile } from "./shell.ts";
import { archiveContract, loadContract, openContracts, pruneRegistry, updateContract } from "./store.ts";
import {
  approve,
  formatContract,
  missingEvidence,
  nextStep,
  phaseOf,
  recordPr,
  requestChanges,
  type Contract,
  type Phase,
} from "./state.ts";

interface HookInput {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}

type HookOutput = Record<string, unknown> | undefined;

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function context(event: string, text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function deny(reason: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Delivery gate: ${reason}` } };
}

/** Shown to the user, never sent to the model. */
function answerUser(reason: string): HookOutput {
  return { decision: "block", reason };
}

interface Found {
  repo: Repo;
  contract: Contract;
}

function active(cwd: string): Found | undefined {
  const repo = existsSync(cwd) ? repoAt(cwd) : undefined;
  const contract = repo && loadContract(repo);
  return repo && contract ? { repo, contract } : undefined;
}

type Open = ReturnType<typeof openContracts>[number];

/** An open contract, located in the worktree where its branch is checked out now. */
function locate(open: Open): Found | undefined {
  const top = worktreeOf(open.commonDir, open.contract.branch);
  if (!top) return undefined;
  const repo = { top, commonDir: open.commonDir, branch: open.contract.branch };
  const contract = loadContract(repo);
  return contract ? { repo, contract } : undefined;
}

function commonDirOf(cwd: string): string | undefined {
  return existsSync(cwd) ? commonDirAt(cwd) : undefined;
}

/**
 * The contract a session is working. A T3 thread may live in a worktree with a detached HEAD while
 * its branch is checked out elsewhere, so the cwd alone is not enough: first a contract this session
 * worked, then the cwd's branch, then (for the user's commands and publishing only, where being
 * strict is safe) the only open contract of the cwd's repository.
 */
function sessionContract(input: HookInput, sameRepo = true): Found | undefined {
  const open = openContracts();
  const own = input.session_id ? open.filter((o) => o.contract.sessions?.includes(input.session_id!)) : [];
  if (own.length === 1) return locate(own[0]);
  const here = active(input.cwd);
  if (here || !sameRepo) return here;
  const common = commonDirOf(input.cwd);
  const inRepo = common ? open.filter((o) => o.commonDir === common) : [];
  return inRepo.length === 1 ? locate(inRepo[0]) : undefined;
}

function listOpen(open: Open[]): string {
  if (open.length === 0) return "There are no open delivery contracts.";
  return ["Open contracts:", ...open.map((o) => {
    const where = worktreeOf(o.commonDir, o.contract.branch);
    return `  ${o.contract.ticket} · ${o.contract.branch} · ${where ?? "branch not checked out in any worktree"}`;
  })].join("\n");
}

/** Remembers that this session works the contract, so later hooks find it from any worktree. */
function recordSession(found: Found, sessionId: string | undefined): void {
  if (!sessionId || found.contract.sessions?.includes(sessionId)) return;
  updateContract(found.repo, (latest) => latest.sessions?.includes(sessionId)
    ? latest
    : { ...latest, sessions: [...(latest.sessions ?? []), sessionId] });
}

/** Closes the contract once its PR has merged. */
function settleMerged({ repo, contract }: Found): Contract {
  if (!contract.pr || contract.pr.merged) return contract;
  try {
    const state = execFileSync("gh", ["pr", "view", contract.pr.url, "--json", "state", "--jq", ".state"], {
      cwd: repo.top, encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (state !== "MERGED") return contract;
    const merged = updateContract(repo, (latest) => ({ ...latest, pr: latest.pr && { ...latest.pr, merged: true } }));
    archiveContract(repo, "merged");
    return merged;
  } catch {
    return contract;
  }
}

/** Shown once per session in a repository without a contract: the agent decides, as in pi-delivery. */
const WHEN_TO_DELIVER = "Delivery: before substantial or risky work in this repository (a ticket, several material acceptance criteria, a multi-file feature or refactor, data/auth/payments/migrations), open a delivery contract with the delivery skill. Skip it for questions, diagnostics and small low-risk edits.";

function sessionStart(input: HookInput): HookOutput {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) appendFileSync(envFile, `export PATH="${BIN}:$PATH"\n`);
  pruneRegistry();
  const found = sessionContract(input, false);
  if (!found) return existsSync(input.cwd) && repoAt(input.cwd) ? context("SessionStart", WHEN_TO_DELIVER) : undefined;
  const contract = settleMerged(found);
  const phase = contract.pr?.merged ? "merged" : phaseOf(contract, treeOf(found.repo.top));
  const where = found.repo.top === repoAt(input.cwd)?.top ? "" : `\nThe branch is checked out at ${found.repo.top}; run git and \`delivery\` there.`;
  return context("SessionStart", `${formatContract(contract, phase)}${where}\n(CLI: \`delivery\`, also at ${BIN}/delivery. The delivery skill explains the workflow.)`);
}

const PROMPT_COMMAND = /^\/(?:delivery:)?(approve|changes|delivery-reset|delivery-status|delivery-skip)(?:\s+([\s\S]*))?$/;

function userPrompt(input: HookInput): HookOutput {
  const match = (input.prompt?.trim() ?? "").match(PROMPT_COMMAND);
  if (!match) return undefined;
  const [, command, given = ""] = match;
  if (command === "delivery-skip") {
    if (!input.session_id) return answerUser("Delivery: this session has no id, so it cannot be waived.");
    skipSession(input.session_id);
    return context("UserPromptSubmit", "Delivery: the user waived the delivery contract for this session. Continue without one.");
  }
  // `/approve SHIELD-2399 …` names the contract explicitly.
  const open = openContracts();
  const word = given.trim().split(/\s+/)[0]?.toLowerCase();
  const matches = open.filter((o) => o.contract.ticket.toLowerCase() === word);
  const common = commonDirOf(input.cwd);
  const named = matches.length === 1 ? matches[0] : matches.find((o) => o.commonDir === common);
  if (matches.length > 1 && !named) {
    return answerUser(`Several open contracts are named ${matches[0].contract.ticket}; run this from a session in the right repository.\n${listOpen(matches)}`);
  }
  // Reset and status take nothing but a ticket, so a name that matches no open contract is a miss, never
  // a fallback to whatever contract this session happens to work.
  if (word && !named && (command === "delivery-reset" || command === "delivery-status")) {
    return answerUser(`No open contract is named ${given.trim().split(/\s+/)[0]}.\n${listOpen(open)}`);
  }
  const rest = named ? given.trim().slice(named.contract.ticket.length).trim() : given;
  const found = named ? locate(named) : sessionContract(input);
  if (!found) {
    const why = named
      ? `The branch of ${named.contract.ticket} (${named.contract.branch}) is not checked out in any worktree.`
      : "No delivery contract for this session or branch. Name it: /" + command + " <TICKET>.";
    return answerUser(`${why}\n${listOpen(open)}`);
  }
  recordSession(found, input.session_id);
  const { repo } = found;
  const tree = treeOf(repo.top);

  if (command === "delivery-status") {
    const contract = settleMerged(found);
    return answerUser(formatContract(contract, contract.pr?.merged ? "merged" : phaseOf(contract, tree)));
  }

  if (command === "delivery-reset") {
    const archived = archiveContract(repo, "reset");
    return answerUser(`Contract ${found.contract.ticket} (${repo.branch}) archived${archived ? ` at ${archived}` : ""}.`);
  }

  if (command === "changes") {
    if (!rest.trim()) return answerUser("Say what has to change: /changes <reason>.");
    const next = updateContract(repo, (latest) => requestChanges(latest, rest, tree));
    return context("UserPromptSubmit", `Delivery: the user requested changes on ${next.ticket}; any earlier approval is withdrawn. Address exactly what they asked, update the evidence of the affected ACs, then \`delivery review\` and stop.`);
  }

  // approve
  const forced = /(^|\s)--force(?=\s|$)/.test(rest);
  const note = rest.replace(/(^|\s)--force(?=\s|$)/g, " ").trim();
  const refusal = { value: undefined as string | undefined };
  const next = updateContract(repo, (latest) => {
    const phase = phaseOf(latest, tree);
    if (phase === "approved" || phase === "ready" || phase === "pr-open") refusal.value = "This exact tree is already approved.";
    else if (!forced && !latest.reviewRequest) {
      refusal.value = "The agent has not requested review yet, so evidence may be incomplete. /approve --force approves the current files anyway.";
    } else if (!forced && latest.reviewRequest && latest.reviewRequest.tree !== tree) {
      const paths = summarizePaths(changedPaths(repo.top, latest.reviewRequest.tree, tree));
      refusal.value = `Files changed after the review was requested: ${paths}. Ask the agent to request review again, or /approve --force to approve the current files.`;
    }
    return refusal.value ? latest : approve(latest, tree, note, forced);
  });
  if (refusal.value) return answerUser(refusal.value);
  const checks = loadConfig(repo.top).checks;
  return context("UserPromptSubmit", [
    `Delivery: the user approved ${next.ticket} on the current files of ${repo.top} (${repo.branch})${note ? ` (“${note}”)` : ""}.`,
    `Next: run \`delivery check\`${checks.length > 0 ? ` (${checks.join(" · ")})` : ""}. Do not edit anything: any change invalidates the approval.`,
  ].join("\n"));
}

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => stringsIn(item, out));
  return out;
}

const SETTINGS_FILE = /(^|\/)\.claude\/settings(\.local)?\.json$/;
const DISABLES_GATE = /disableAllHooks|"delivery@prjct"\s*:\s*false/;

/** Edits to Claude settings that would switch the gate off. Other settings edits are fine. */
function disablesGate(path: string, args: Record<string, unknown>): boolean {
  if (!SETTINGS_FILE.test(path)) return false;
  const written = stringsIn([args.content, args.new_string, args.edits]).join("\n");
  if (DISABLES_GATE.test(written)) return true;
  if (typeof args.content === "string" && existsSync(path)) {
    return readFileSync(path, "utf8").includes("delivery@prjct") && !args.content.includes("delivery@prjct");
  }
  if (typeof args.old_string === "string" && args.old_string.includes("delivery@prjct")) {
    return !String(args.new_string ?? "").includes("delivery@prjct");
  }
  return false;
}

function gateFor(found: Found, cache: Map<string, string>): { tree: string; phase: Phase; stale: string } {
  const { repo, contract } = found;
  const tree = cache.get(repo.top) ?? treeOf(repo.top);
  cache.set(repo.top, tree);
  const stale = contract.approval && contract.approval.tree !== tree
    ? ` The approval is stale: ${summarizePaths(changedPaths(repo.top, contract.approval.tree, tree))} changed after it.`
    : "";
  return { tree, phase: phaseOf(contract, tree), stale };
}

/**
 * What gets published is the commit, not the working tree: it must hold exactly the approved files,
 * nothing missing and nothing extra.
 */
function publishBlocker(found: Found, tree: string): HookOutput {
  const head = headTree(found.repo.top);
  if (head === tree) return undefined;
  const paths = summarizePaths(changedPaths(found.repo.top, head, tree));
  return deny(`the commit you would publish differs from the approved files (${paths}). Commit exactly the approved changes (\`git add -A && git commit\`) in its own command, then publish.`);
}

/**
 * A publish from a worktree whose HEAD has no contract (e.g. a detached T3 worktree) still moves the
 * contract's branch when it names it, or when this session works a contract of the same repository.
 */
function publishTarget(input: HookInput, dir: string, tokens: string[]): Found | undefined {
  const common = commonDirOf(dir);
  if (!common) return undefined;
  const sameRepo = openContracts().filter((o) => o.commonDir === common);
  // `feat/x`, `+feat/x`, `HEAD:feat/x`, `HEAD:refs/heads/feat/x`
  const targets = tokens.map((token) => token.replace(/^\+/, "").split(":").at(-1)!.replace(/^refs\/heads\//, ""));
  const branchRef = (branch: string) => targets.includes(branch);
  const named = sameRepo.find((o) => branchRef(o.contract.branch));
  if (named) return locate(named);
  const own = sameRepo.find((o) => input.session_id && o.contract.sessions?.includes(input.session_id));
  return own && locate(own);
}

function preBash(input: HookInput, command: string): HookOutput {
  if (touchesStore(command)) return deny("the contract is changed only through the `delivery` CLI; read it with `delivery status`.");
  if (/disableAllHooks/.test(command) || /\bclaude\s+plugins?\s+(disable|uninstall|remove)\b/.test(command)) {
    return deny("switching off hooks or plugins while a delivery contract is open is the user's call.");
  }
  if (USER_COMMAND_ANYWHERE.test(command) && segments(command).some((tokens) => tokens[0] === "claude")) {
    return deny("/approve, /changes and /delivery-reset come from the user, not from a session you start.");
  }

  const trees = new Map<string, string>();
  const repos = new Map<string, Found | undefined>();
  for (const { tokens, dir } of located(command, input.cwd)) {
    const action = publishOf(tokens);
    const found = repos.has(dir) ? repos.get(dir) : active(dir) ?? (action ? publishTarget(input, dir, tokens) : undefined);
    repos.set(dir, found);
    if (!found) {
      const blocker = action ? undefined : gateCheckWithoutContract(input, dir, tokens);
      if (blocker) return blocker;
      continue;
    }
    if (writesFile(command, CONFIG_PATH)) return deny(`${CONFIG_PATH} defines the checks; only the user changes it.`);
    if (action === "pr-merge") return deny("merging is the user's call.");
    const config = action ? undefined : loadConfig(found.repo.top);
    const fullCheck = config && fullCheckOf(tokens, checkKeys(config.checks, config.scripts));
    if (!action && !fullCheck) continue;

    const { tree, phase, stale } = gateFor(found, trees);
    if (action) {
      if (phase === "ready" || phase === "pr-open") {
        const blocker = publishBlocker(found, tree);
        if (blocker) return blocker;
        continue;
      }
      return deny(`pushing and opening the PR wait for the user's approval and passing checks on the same files.${stale} ${nextStep(phase)}`);
    }
    if (phase === "implementing" || phase === "review") {
      return deny(`\`${tokens.join(" ")}\` runs the full check \`${fullCheck}\`, which waits for the user's approval and then runs through \`delivery check\`. Targeted runs (naming a test file or path) are allowed.${stale}`);
    }
    return deny("run the full checks through `delivery check` so their results are recorded against the approved files.");
  }
  return undefined;
}

/** The contract a PR tool call belongs to: its head branch, else the session's contract. */
function prContract(input: HookInput, args: Record<string, unknown>): Found | undefined {
  const head = typeof args.head === "string" ? args.head.replace(/^[^:]+:/, "") : undefined;
  const byBranch = head ? openContracts().find((o) => o.contract.branch === head) : undefined;
  return (byBranch && locate(byBranch)) ?? sessionContract(input);
}

/** Work in a repository without a contract: substantial or risky work waits for one. */
function gateWithoutContract(input: HookInput, repo: Repo, work: Work, consequence: string): HookOutput {
  // A session working a contract from another worktree (T3) is covered by it.
  if (input.session_id && openContracts().some((o) => o.contract.sessions?.includes(input.session_id!))) return undefined;
  const gate = judgeWork(repo, work, input.session_id, input.transcript_path);
  if ("unjudged" in gate) return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: WHEN_TO_DELIVER } };
  if (!gate.needed) return undefined;
  return deny([
    `this task needs a delivery contract (${gate.reason})${consequence}. Load the delivery skill and open one first:`,
    "`delivery start --ticket <id> --title … --ac …`, with the ticket's ACs, or, without a ticket, `--ticket ADHOC-<slug> --source request` and the outcomes the user asked for.",
    "If you think it does not need one, say so and ask the user; only they can waive it (/delivery-skip).",
  ].join(" "));
}

function gateEditWithoutContract(input: HookInput, path: string): HookOutput {
  const repo = repoAt(existsSync(dirname(path)) ? dirname(path) : input.cwd);
  return repo ? gateWithoutContract(input, repo, { path }, " before editing") : undefined;
}

/** A full check without a contract is judged like an edit: it is what a contract defers until approval. */
function gateCheckWithoutContract(input: HookInput, dir: string, tokens: string[]): HookOutput {
  const repo = existsSync(dir) ? repoAt(dir) : undefined;
  if (!repo) return undefined;
  const config = loadConfig(repo.top);
  const fullCheck = fullCheckOf(tokens, checkKeys(config.checks, config.scripts));
  if (!fullCheck) return undefined;
  const command = tokens.join(" ");
  return gateWithoutContract(input, repo, { command }, `; \`${command}\` runs the full check \`${fullCheck}\`, which then runs through \`delivery check\` after the user's approval. Targeted runs (naming a test file or path) are allowed now`);
}

function preToolUse(input: HookInput): HookOutput {
  const tool = input.tool_name ?? "";
  const args = input.tool_input ?? {};

  // Prompts that another session or thread would receive as the user's own.
  if ((tool.startsWith("mcp__") || tool === "SendMessage") && stringsIn(args).some((text) => USER_COMMAND.test(text))) {
    return deny("/approve, /changes and /delivery-reset come from the user. Do not send them to any session or thread.");
  }

  if (FILE_TOOLS.has(tool)) {
    const path = resolve(input.cwd, String(args.file_path ?? args.notebook_path ?? ""));
    if (disablesGate(path, args)) return deny("switching off hooks or this plugin while a delivery contract is open is the user's call.");
    if (touchesStore(path)) return deny("the contract is changed only through the `delivery` CLI.");
    const found = active(dirname(path)) ?? active(input.cwd);
    if (found && relative(found.repo.top, path) === CONFIG_PATH) return deny(`${CONFIG_PATH} defines the checks; only the user changes it.`);
    return found ? undefined : gateEditWithoutContract(input, path);
  }

  if (tool.startsWith("mcp__")) {
    if (!/(create|merge)_pull_request/i.test(tool)) return undefined;
    const found = prContract(input, args);
    if (!found) return undefined;
    if (/merge_pull_request/i.test(tool)) return deny("merging is the user's call.");
    const { tree, phase, stale } = gateFor(found, new Map());
    return phase === "ready" || phase === "pr-open" ? publishBlocker(found, tree) : deny(`no PR before the user's approval and passing checks.${stale} ${nextStep(phase)}`);
  }

  return tool === "Bash" ? preBash(input, String(args.command ?? "")) : undefined;
}

function postToolUse(input: HookInput): HookOutput {
  const tool = input.tool_name ?? "";
  const args = input.tool_input ?? {};
  if (tool === "Bash") {
    const command = String(args.command ?? "");
    const steps = located(command, input.cwd);
    // A session that runs the CLI works that contract, wherever it sits.
    if (/delivery/.test(command)) {
      for (const dir of new Set([input.cwd, ...steps.map((step) => step.dir)])) {
        const found = active(dir);
        if (found) recordSession(found, input.session_id);
      }
    }
    const step = steps.find((candidate) => publishOf(candidate.tokens) === "pr-create");
    if (!step) return undefined;
    return recordPrUrl(active(step.dir) ?? sessionContract(input), input.tool_response);
  }
  if (!/create_pull_request/i.test(tool)) return undefined;
  return recordPrUrl(prContract(input, args), input.tool_response);
}

function recordPrUrl(found: Found | undefined, response: unknown): HookOutput {
  if (!found || found.contract.pr) return undefined;
  const url = JSON.stringify(response ?? "").match(/https?:\/\/[^\s"'\\]+\/pull\/\d+/)?.[0];
  if (url) updateContract(found.repo, (latest) => latest.pr ? latest : recordPr(latest, url));
  return undefined;
}

function stop(input: HookInput): HookOutput {
  if (input.stop_hook_active) return undefined;
  const found = sessionContract(input, false);
  if (!found) return undefined;
  const { repo, contract } = found;
  const tree = treeOf(repo.top);
  if (tree === contract.startTree || contract.nudgedTree === tree) return undefined;
  const phase = phaseOf(contract, tree);
  const missing = missingEvidence(contract);
  const reason = phase === "implementing"
    ? missing.length > 0
      ? `ACs without evidence: ${missing.map((c) => c.id).join(", ")}. If the work is done, exercise each one, record it with \`delivery evidence\`, then \`delivery review\`.`
      : "Every AC has evidence but review was not requested. If the work is done, run `delivery review`."
    : phase === "approved" && contract.checks?.tree !== tree
      ? "The user approved; run `delivery check` before stopping."
      : undefined;
  if (!reason) return undefined;
  updateContract(repo, (latest) => ({ ...latest, nudgedTree: tree }));
  return { decision: "block", reason: `Delivery (${contract.ticket}): ${reason} If you are stopping to ask the user something or you are blocked, say so and stop.` };
}

const HANDLERS: Record<string, (input: HookInput) => HookOutput> = {
  SessionStart: sessionStart,
  UserPromptSubmit: userPrompt,
  PreToolUse: preToolUse,
  PostToolUse: postToolUse,
  Stop: stop,
};

/** Publishing must not slip through because verification failed. */
function publishes(input: HookInput): boolean {
  if (input.hook_event_name !== "PreToolUse") return false;
  const tool = input.tool_name ?? "";
  if (tool === "Bash") return publishAction(String(input.tool_input?.command ?? "")) !== undefined;
  return /(create|merge)_pull_request/i.test(tool);
}

const raw = readFileSync(0, "utf8");
try {
  const input = JSON.parse(raw) as HookInput;
  try {
    const output = HANDLERS[input.hook_event_name]?.(input);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (publishes(input)) process.stdout.write(JSON.stringify(deny(`could not verify the contract (${message}); not publishing.`)));
    else if (input.hook_event_name === "UserPromptSubmit" && PROMPT_COMMAND.test(input.prompt?.trim() ?? "")) {
      process.stdout.write(JSON.stringify(answerUser(`Delivery: ${message}`)));
    } else process.stderr.write(`delivery hook: ${message}\n`);
  }
} catch (error) {
  process.stderr.write(`delivery hook: unreadable input (${error instanceof Error ? error.message : String(error)})\n`);
}
