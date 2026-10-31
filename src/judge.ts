// The fallback for work started without a contract. The agent is asked to open one for substantial or
// risky work (see the SessionStart hook); when it does not, the first edit is checked here. A cheap
// filter decides whether the task could be substantial at all, and only then a small model judges it,
// once per user prompt. Verdicts are kept per session, so later edits cost a file read.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { git, type Repo } from "./git.ts";

/** Changed files (with the one about to be edited) from which a contract-less task is judged. */
export const CHANGED_FILES_THRESHOLD = 3;

const TICKET_REF = /\b[A-Z][A-Z0-9]{1,9}-\d+\b|\bCU-[a-z0-9]{5,}\b|https?:\/\/\S*(?:atlassian\.net\/browse|app\.clickup\.com\/t|linear\.app\/\S+\/issue|github\.com\/\S+\/issues)\/\S+/;
/** A branch named as a feature is substantial work by declaration, however small the first edit. */
const FEATURE_BRANCH = /^(?:feat|feature)s?\//;

export interface Verdict {
  /** Hash of the user prompt the verdict answers; a new prompt is judged again. */
  prompt: string;
  needed: boolean;
  reason: string;
  /** Changed files when judged, so a "no" is reused until the work grows. */
  changed: number;
  at: string;
}

interface SessionRecord {
  verdict?: Verdict;
  /** The user waived delivery for this session (/delivery-skip). */
  skipped?: string;
}

function judgedDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "claude-delivery", "judged");
}

function recordPath(sessionId: string): string {
  return join(judgedDir(), `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function loadRecord(sessionId: string): SessionRecord {
  try {
    return JSON.parse(readFileSync(recordPath(sessionId), "utf8")) as SessionRecord;
  } catch {
    return {};
  }
}

function saveRecord(sessionId: string, record: SessionRecord): void {
  mkdirSync(judgedDir(), { recursive: true });
  const path = recordPath(sessionId);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function skipSession(sessionId: string): void {
  saveRecord(sessionId, { ...loadRecord(sessionId), skipped: new Date().toISOString() });
}

/** "merge", "mergea", "mergear", "haz merge", "fusiona", "fusionar", "merge it", "merge the PR"... in any case. */
const ASKS_MERGE = /\b(merge[a-z]*|fusion[a-z]*)\b/i;

/** True when one of the user's last messages asks for a merge: typed or dictated, in English or Spanish. */
export function userAskedMerge(transcriptPath: string | undefined): boolean {
  return lastUserPrompts(transcriptPath).some((text) => ASKS_MERGE.test(text));
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** The user's last messages, oldest first, from the tail of the transcript (tool results excluded). */
export function lastUserPrompts(transcriptPath: string | undefined, count = 3): string[] {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const fd = openSync(transcriptPath, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const prompts: string[] = [];
    for (const line of buffer.toString("utf8").split("\n").reverse()) {
      if (prompts.length >= count) break;
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "user" || entry.isMeta || entry.message?.role !== "user") continue;
        const text = textOf(entry.message.content)?.trim();
        if (text && !text.startsWith("<")) prompts.push(text);
      } catch {}
    }
    return prompts.reverse();
  } finally {
    closeSync(fd);
  }
}

/** Paths changed in the working tree, with the one about to be edited if any. */
function changedFiles(repo: Repo, path: string | undefined): string[] {
  let lines: string[] = [];
  try {
    lines = git(repo.top, ["status", "--porcelain", "--untracked-files=normal"]).split("\n").filter(Boolean).map((line) => line.slice(3));
  } catch {}
  if (!path) return lines;
  const target = relative(repo.top, path);
  return lines.includes(target) ? lines : [...lines, target];
}

/** What the agent is about to do without a contract: edit a file, or run a full check. */
export type Work = { path: string } | { command: string };

const JUDGE_PROMPT = `You decide whether a coding task must run under a delivery contract: acceptance criteria, the user's review and approval, full checks after approval, then the PR.
Answer YES when the task is substantial or risky: it implements a ticket, issue or story; it has several material acceptance criteria; it is a feature or refactor across several files; or it touches data, auth, payments, migrations, public APIs or deployment.
Answer NO for questions, diagnostics, reviews, small low-risk edits, config or docs tweaks, or when the user said not to use delivery.
Reply with exactly one line: "YES: <reason>" or "NO: <reason>", the reason under 15 words.`;

/** Runs the judge model; undefined when it cannot answer in time. */
function askJudge(input: string): { needed: boolean; reason: string } | undefined {
  const bin = process.env.CLAUDE_DELIVERY_JUDGE_BIN || "claude";
  const result = spawnSync(bin, [
    "-p", "--model", process.env.CLAUDE_DELIVERY_JUDGE_MODEL || "haiku",
    "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--settings", JSON.stringify({ disableAllHooks: true }),
  ], {
    input,
    encoding: "utf8",
    timeout: 12_000,
    // The judge's own session must not run these hooks again.
    env: { ...process.env, CLAUDE_DELIVERY_JUDGE: "1" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const answer = result.stdout?.trim().match(/^(YES|NO)\b[:\s-]*(.*)$/im);
  if (!answer) return undefined;
  return { needed: answer[1].toUpperCase() === "YES", reason: answer[2].trim() || "no reason given" };
}

export type Gate = { needed: true; reason: string } | { needed: false } | { unjudged: true };

/** Whether work without a contract has to wait for one. */
export function judgeWork(repo: Repo, work: Work, sessionId: string | undefined, transcriptPath: string | undefined): Gate {
  if (!sessionId) return { needed: false };
  const path = "path" in work ? work.path : undefined;
  const record = loadRecord(sessionId);
  if (record.skipped) return { needed: false };

  const prompts = lastUserPrompts(transcriptPath);
  const latest = prompts.at(-1) ?? "";
  const key = createHash("sha256").update(latest).digest("hex").slice(0, 16);
  const previous = record.verdict;
  if (previous?.prompt === key) return previous.needed ? { needed: true, reason: previous.reason } : { needed: false };

  const changed = changedFiles(repo, path);
  const ticket = TICKET_REF.test(latest) || TICKET_REF.test(repo.branch) || FEATURE_BRANCH.test(repo.branch);
  if (!ticket && changed.length < CHANGED_FILES_THRESHOLD) return { needed: false };
  // A "no" stands for later prompts until a ticket shows up or the work grows by a few more files.
  if (previous && !previous.needed && !ticket && changed.length < previous.changed + CHANGED_FILES_THRESHOLD) {
    return { needed: false };
  }

  const verdict = askJudge([
    JUDGE_PROMPT,
    "",
    "User's recent messages (most recent last):",
    ...prompts.map((text, index) => `[${index + 1}] ${text.slice(0, 1500)}`),
    "",
    `Branch: ${repo.branch}`,
    `Files changed so far (${changed.length}): ${changed.slice(0, 20).join(", ")}`,
    path ? `File about to be edited: ${relative(repo.top, path)}` : `Command about to run: ${(work as { command: string }).command}`,
  ].join("\n"));
  if (!verdict) return { unjudged: true };
  saveRecord(sessionId, { ...record, verdict: { prompt: key, ...verdict, changed: changed.length, at: new Date().toISOString() } });
  return verdict.needed ? { needed: true, reason: verdict.reason } : { needed: false };
}
