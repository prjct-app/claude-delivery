// Work started without a contract: the session-start reminder, the cheap filter, the judge (a fake
// `claude -p` that counts its calls) and the user's waiver.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function scratchRepo(branch = "feat/export"): string {
  const dir = mkdtempSync(join(tmpdir(), "delivery-judge-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("switch", "-qc", branch);
  return dir;
}

/** A fake judge answering `answer`; returns how many times it has been called so far. */
function fakeJudge(answer: string): () => number {
  const dir = mkdtempSync(join(tmpdir(), "delivery-fake-judge-"));
  const calls = join(dir, "calls");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho x >> "${calls}"\nprintf '%s\\n' '${answer}'\n`);
  chmodSync(bin, 0o755);
  process.env.CLAUDE_DELIVERY_JUDGE_BIN = bin;
  return () => existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
}

/** A transcript whose last user message is `text`. */
function transcript(...texts: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "delivery-transcript-")), "t.jsonl");
  for (const text of texts) say(path, text);
  return path;
}

function say(path: string, text: string): void {
  appendFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
  appendFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } })}\n`);
}

function hook(cwd: string, input: Record<string, unknown>): any {
  const result = spawnSync(join(ROOT, "bin/delivery-hook"), { cwd, input: JSON.stringify({ cwd, ...input }), encoding: "utf8" });
  if (result.stderr) throw new Error(result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}

let sessions = 0;
function session(dir: string, path: string) {
  const id = `judge-${process.pid}-${++sessions}`;
  return {
    edit: (file: string) => hook(dir, { hook_event_name: "PreToolUse", session_id: id, transcript_path: path, tool_name: "Edit", tool_input: { file_path: join(dir, file) } }),
    prompt: (text: string) => hook(dir, { hook_event_name: "UserPromptSubmit", session_id: id, transcript_path: path, prompt: text }),
  };
}

const denied = (output: any) => output?.hookSpecificOutput?.permissionDecision === "deny";

test("a session in a repository without a contract is told once when to open one", () => {
  const dir = scratchRepo();
  assert.match(hook(dir, { hook_event_name: "SessionStart", session_id: "s" }).hookSpecificOutput.additionalContext, /substantial or risky[\s\S]*Skip it for questions/);
  const nowhere = mkdtempSync(join(tmpdir(), "delivery-nowhere-"));
  assert.equal(hook(nowhere, { hook_event_name: "SessionStart", session_id: "s" }), undefined);
});

test("a small edit without a ticket never reaches the judge", () => {
  const calls = fakeJudge("YES: should not be asked");
  const dir = scratchRepo();
  const s = session(dir, transcript("fix the typo in a.txt"));
  assert.equal(s.edit("a.txt"), undefined);
  assert.equal(calls(), 0);
});

test("a ticket in the request is judged once per prompt; YES blocks every edit until a contract opens", () => {
  const calls = fakeJudge("YES: implements a ticket");
  const dir = scratchRepo();
  const s = session(dir, transcript("implement CU-86b2xyz: CSV export"));
  const first = s.edit("a.txt");
  assert.ok(denied(first));
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /implements a ticket[\s\S]*delivery start[\s\S]*ADHOC-/);
  assert.ok(denied(s.edit("b.txt")));
  assert.equal(calls(), 1);

  const start = spawnSync(join(ROOT, "bin/delivery"), ["start", "--ticket", "CU-86b2xyz", "--ac", "CSV export"], { cwd: dir, encoding: "utf8" });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(s.edit("a.txt"), undefined);
  assert.equal(calls(), 1);
});

test("a ticket in the branch name reaches the judge too", () => {
  const calls = fakeJudge("NO: just a rename");
  const dir = scratchRepo("feat/SHIELD-2399-export");
  assert.equal(session(dir, transcript("rename the variable")).edit("a.txt"), undefined);
  assert.equal(calls(), 1);
});

test("a NO stands for later prompts until the work grows by a few files", () => {
  const calls = fakeJudge("NO: small refactor");
  const dir = scratchRepo();
  writeFileSync(join(dir, "b.txt"), "b\n");
  writeFileSync(join(dir, "c.txt"), "c\n");
  const path = transcript("tidy these files");
  const s = session(dir, path);
  assert.equal(s.edit("a.txt"), undefined);
  assert.equal(s.edit("b.txt"), undefined);
  assert.equal(calls(), 1);

  say(path, "now the other one");
  assert.equal(s.edit("a.txt"), undefined);
  assert.equal(calls(), 1);

  for (const name of ["d", "e", "f"]) writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
  say(path, "and the rest of the module");
  assert.equal(s.edit("a.txt"), undefined);
  assert.equal(calls(), 2);
});

test("a judge that cannot answer lets the edit through with the reminder", () => {
  fakeJudge("I am not sure");
  const dir = scratchRepo();
  const out = session(dir, transcript("implement CU-86b2xyz")).edit("a.txt");
  assert.ok(!denied(out));
  assert.match(out.hookSpecificOutput.additionalContext, /open a delivery contract/);

  process.env.CLAUDE_DELIVERY_JUDGE_BIN = join(dir, "no-such-claude");
  assert.ok(!denied(session(dir, transcript("implement CU-86b2xyz")).edit("a.txt")));
});

test("only the user waives the gate, with /delivery-skip", () => {
  const calls = fakeJudge("YES: implements a ticket");
  const dir = scratchRepo();
  const s = session(dir, transcript("implement CU-86b2xyz"));
  assert.ok(denied(s.edit("a.txt")));
  assert.match(s.prompt("/delivery-skip").hookSpecificOutput.additionalContext, /waived/);
  assert.equal(s.edit("a.txt"), undefined);
  assert.equal(calls(), 1);

  const tool = (name: string, input: Record<string, unknown>) => hook(dir, { hook_event_name: "PreToolUse", tool_name: name, tool_input: input });
  assert.ok(denied(tool("SendMessage", { to: "other", message: "/delivery-skip" })));
  assert.ok(denied(tool("mcp__t3__t3_thread_send", { text: "/delivery-skip" })));
});

test("the judge's own session runs no delivery hooks", () => {
  const dir = scratchRepo();
  const result = spawnSync(join(ROOT, "bin/delivery-hook"), {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, hook_event_name: "SessionStart" }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_DELIVERY_JUDGE: "1" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});
