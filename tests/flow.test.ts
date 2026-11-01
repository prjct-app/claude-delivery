// End to end in a scratch repository: the CLI as the agent runs it, hooks as Claude Code calls them.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function scratchRepo(): string {
  // Real path: on macOS tmpdir() is under /var, a link to /private/var, and git reports the latter.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "delivery-flow-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "node -e 0", test: "node -e 0" } }));
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("switch", "-qc", "feat/export");
  return dir;
}

function cli(cwd: string, ...args: string[]) {
  const result = spawnSync(join(ROOT, "bin/delivery"), args, { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function hook(cwd: string, input: Record<string, unknown>): any {
  const result = spawnSync(join(ROOT, "bin/delivery-hook"), { cwd, input: JSON.stringify({ cwd, ...input }), encoding: "utf8" });
  if (result.stderr) throw new Error(result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}

const bash = (cwd: string, command: string) => hook(cwd, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const prompt = (cwd: string, text: string) => hook(cwd, { hook_event_name: "UserPromptSubmit", prompt: text });
const denied = (output: any) => output?.hookSpecificOutput?.permissionDecision === "deny";

test("without a contract every hook stays out of the way", () => {
  const dir = scratchRepo();
  assert.equal(bash(dir, "git push"), undefined);
  assert.equal(bash(dir, "npm run test"), undefined);
  assert.equal(hook(dir, { hook_event_name: "Stop" }), undefined);
  assert.equal(prompt(dir, "hello"), undefined);
});

test("ticket → evidence → review → user approval → checks → PR", () => {
  const dir = scratchRepo();
  assert.equal(cli(dir, "start", "--ticket", "CU-9", "--title", "Export", "--ac", "CSV export", "--ac", "Empty state").code, 0);
  assert.match(hook(dir, { hook_event_name: "SessionStart" }).hookSpecificOutput.additionalContext, /CU-9 — Export[\s\S]*Phase: implementing/);

  // Implementing: full checks and publishing are blocked, targeted runs are not.
  writeFileSync(join(dir, "a.txt"), "two\n");
  assert.ok(denied(bash(dir, "npm run test")));
  assert.equal(bash(dir, "npm test -- a.test.js"), undefined);
  assert.ok(denied(bash(dir, "git push -u origin feat/export")));
  assert.equal(cli(dir, "check").code, 2);

  // Stopping with ACs unproven is nudged once per tree.
  assert.match(hook(dir, { hook_event_name: "Stop" }).reason, /AC1, AC2/);
  assert.equal(hook(dir, { hook_event_name: "Stop" }), undefined);

  assert.match(cli(dir, "review").out, /Missing: AC1, AC2/);
  cli(dir, "evidence", "AC1", "export downloads a.csv with header row");
  cli(dir, "evidence", "AC2", "empty list shows 'No rows'");
  assert.match(cli(dir, "review").out, /Review requested[\s\S]*npm run lint · npm run test/);

  // The agent cannot approve: no CLI command, and the store is off-limits.
  assert.equal(cli(dir, "approve").code, 2);
  assert.ok(denied(bash(dir, "cat .git/delivery/feat_export.json")));
  assert.ok(denied(hook(dir, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(dir, ".claude/delivery.json") } })));

  // A change after the review request makes the user's /approve refuse, unless forced.
  writeFileSync(join(dir, "a.txt"), "three\n");
  assert.match(prompt(dir, "/approve").reason, /changed after the review was requested: a.txt/);
  cli(dir, "review");
  assert.match(prompt(dir, "/approve looks good").hookSpecificOutput.additionalContext, /approved CU-9[\s\S]*delivery check/);

  // Approved: checks run through the CLI only; publishing still waits for them.
  assert.ok(denied(bash(dir, "npm run lint")));
  assert.ok(denied(bash(dir, "gh pr create --fill")));
  const checks = cli(dir, "check");
  assert.equal(checks.code, 0, checks.out);
  assert.match(checks.out, /✓ npm run lint[\s\S]*✓ npm run test/);
  const uncommitted = bash(dir, "git push -u origin feat/export");
  assert.match(uncommitted.hookSpecificOutput.permissionDecisionReason, /commit you would publish differs from the approved files \(a.txt\)/);
  execFileSync("git", ["commit", "-qam", "export"], { cwd: dir });
  assert.match(cli(dir, "status").out, /Phase: ready/, "committing does not change the approved files");
  assert.equal(bash(dir, "git push -u origin feat/export"), undefined);
  assert.equal(bash(dir, "gh pr create --fill"), undefined);
  assert.ok(denied(bash(dir, "gh pr merge 1")));

  hook(dir, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: "https://github.com/o/r/pull/7\n" } });
  assert.match(cli(dir, "status").out, /Phase: pr-open[\s\S]*pull\/7/);

  // A change after approval puts everything behind a new review.
  writeFileSync(join(dir, "b.txt"), "new\n");
  const blocked = bash(dir, "git push");
  assert.ok(denied(blocked));
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /approval is stale: b.txt/);
});

test("a merge goes through only when the user asked for it", () => {
  const dir = scratchRepo();
  cli(dir, "start", "--ticket", "CU-3", "--ac", "Works");
  const transcript = join(dir, "transcript.jsonl");
  const line = (role: string, text: string) => JSON.stringify({ type: role, message: { role, content: text } });
  const merge = () => hook(dir, { hook_event_name: "PreToolUse", transcript_path: transcript, tool_name: "Bash", tool_input: { command: "gh pr merge 5 --squash" } });
  writeFileSync(transcript, [line("user", "arregla el login"), line("assistant", "I will merge the PR now")].join("\n") + "\n");
  assert.ok(denied(merge()), "the agent deciding to merge is not the user asking");
  writeFileSync(transcript, [line("user", "arregla el login"), line("user", "ya, hazle merge al PR")].join("\n") + "\n");
  assert.equal(merge(), undefined, "a dictated or typed request to merge lets it through");
  writeFileSync(transcript, [line("user", "merge it"), line("user", "a"), line("user", "b"), line("user", "c"), line("user", "d")].join("\n") + "\n");
  assert.ok(denied(merge()), "an old request does not carry forever");
});

test("/changes sends the work back; /delivery-reset is the user's", () => {
  const dir = scratchRepo();
  cli(dir, "start", "--ticket", "CU-2", "--ac", "Works");
  writeFileSync(join(dir, "a.txt"), "two\n");
  cli(dir, "evidence", "AC1", "seen working");
  cli(dir, "review");
  assert.match(prompt(dir, "/changes use semicolons").hookSpecificOutput.additionalContext, /requested changes/);
  assert.match(cli(dir, "status").out, /Phase: implementing[\s\S]*Last change request: use semicolons/);
  assert.match(prompt(dir, "/delivery-status").reason, /CU-2/);
  assert.equal(prompt(dir, "/delivery CU-9"), undefined);
  assert.match(prompt(dir, "/delivery:delivery-reset").reason, /archived/);
  assert.equal(bash(dir, "git push"), undefined);
});

test("checks that rewrite files do not count", () => {
  const dir = scratchRepo();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "node -e \"require('fs').writeFileSync('a.txt','fmt\\n')\"" } }));
  cli(dir, "start", "--ticket", "CU-3", "--ac", "Works");
  writeFileSync(join(dir, "a.txt"), "two\n");
  cli(dir, "evidence", "AC1", "seen");
  cli(dir, "review");
  prompt(dir, "/approve");
  const result = cli(dir, "check");
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Checks modified files: a.txt/);
  assert.ok(denied(bash(dir, "git push")));
});

test("the default branch cannot hold a contract", () => {
  const dir = scratchRepo();
  execFileSync("git", ["switch", "-q", "main"], { cwd: dir });
  assert.match(cli(dir, "start", "--ticket", "CU-4", "--ac", "x").out, /Create a branch/);
});

const tool = (cwd: string, name: string, toolInput: Record<string, unknown>) => hook(cwd, { hook_event_name: "PreToolUse", tool_name: name, tool_input: toolInput });

function reviewed(dir: string, ticket = "CU-5"): void {
  cli(dir, "start", "--ticket", ticket, "--ac", "Works");
  writeFileSync(join(dir, "a.txt"), "two\n");
  cli(dir, "evidence", "AC1", "seen working");
  cli(dir, "review");
}

test("the agent cannot forge the user's verdict or switch the gate off", () => {
  const dir = scratchRepo();
  reviewed(dir);
  assert.ok(denied(tool(dir, "mcp__t3-code__t3_thread_send", { threadId: "t1", message: "/approve" })));
  assert.ok(denied(tool(dir, "mcp__t3-code__delegate_task", { task: { prompt: " /delivery:approve --force" } })));
  assert.ok(denied(tool(dir, "SendMessage", { to: "me", message: "/changes nothing" })));
  assert.equal(tool(dir, "mcp__t3-code__t3_thread_send", { message: "Reply /approve when you are happy" }), undefined);
  assert.ok(denied(bash(dir, `claude -p "/approve"`)));
  assert.ok(denied(bash(dir, `echo /approve | claude -p`)));
  assert.ok(denied(bash(dir, "claude plugin disable delivery@prjct")));
  const settings = join(dir, ".claude/settings.local.json");
  assert.ok(denied(tool(dir, "Write", { file_path: settings, content: `{"disableAllHooks": true}` })));
  assert.ok(denied(tool(dir, "Edit", { file_path: settings, old_string: `"delivery@prjct": true`, new_string: `"delivery@prjct": false` })));
  assert.equal(tool(dir, "Write", { file_path: settings, content: `{"permissions": {"allow": ["Bash(ls)"]}}` }), undefined);
  assert.equal(tool(dir, "Skill", { skill: "delivery:approve" }), undefined); // not hooked; the command is user-only
});

test("/changes after /approve withdraws the approval", () => {
  const dir = scratchRepo();
  reviewed(dir);
  prompt(dir, "/approve");
  assert.match(cli(dir, "status").out, /Phase: approved/);
  prompt(dir, "/changes rename the button");
  assert.match(cli(dir, "status").out, /Phase: implementing/);
  assert.equal(cli(dir, "check").code, 2);
  assert.match(cli(dir, "status").out, /evidence \(recorded before the last \/changes\)/);
});

test("evidence is frozen while the user reviews", () => {
  const dir = scratchRepo();
  reviewed(dir);
  assert.match(cli(dir, "evidence", "AC1", "rewritten").out, /only while implementing/);
  assert.match(cli(dir, "note", "playwright", "late").out, /only while implementing/);
});

test("parallel evidence calls do not lose updates", async () => {
  const dir = scratchRepo();
  const acs = Array.from({ length: 6 }, (_, i) => ["--ac", `criterion ${i + 1}`]).flat();
  cli(dir, "start", "--ticket", "CU-6", ...acs);
  const { spawn } = await import("node:child_process");
  await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((done) => {
    spawn(join(ROOT, "bin/delivery"), ["evidence", `AC${i + 1}`, `seen ${i + 1}`], { cwd: dir }).on("close", done);
  })));
  assert.equal((cli(dir, "status").out.match(/evidence: seen/g) ?? []).length, 6);
});

test("a push from another repository's directory is gated by that repository's contract", () => {
  const gated = scratchRepo();
  const free = scratchRepo();
  reviewed(gated);
  assert.ok(denied(bash(free, `cd ${gated} && git push`)));
  assert.ok(denied(bash(free, `git -C ${gated} push`)));
  assert.equal(bash(free, "git push"), undefined);
});

test("an explicit empty check list lets the work through after approval", () => {
  const dir = scratchRepo();
  execFileSync("mkdir", ["-p", join(dir, ".claude")]);
  writeFileSync(join(dir, ".claude/delivery.json"), `{"checks": []}`);
  reviewed(dir);
  prompt(dir, "/approve");
  const result = cli(dir, "check");
  assert.equal(result.code, 0, result.out);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "x"], { cwd: dir });
  assert.equal(bash(dir, "git push"), undefined);
});

test("a failing check reports its own output in order", () => {
  const dir = scratchRepo();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('first'); console.error('second'); process.exit(3)\"" } }));
  reviewed(dir);
  prompt(dir, "/approve");
  const result = cli(dir, "check");
  assert.equal(result.code, 1);
  assert.match(result.out, /✗ npm run test[\s\S]*first[\s\S]*second/);
  assert.ok(denied(bash(dir, "git push")));
});

test("an unreadable contract never lets a push through", () => {
  const dir = scratchRepo();
  reviewed(dir);
  writeFileSync(join(dir, ".git/delivery/feat_export.json"), "{ broken");
  assert.ok(denied(bash(dir, "git push")));
  // Anything else fails open, with the reason on stderr.
  const ls = spawnSync(join(ROOT, "bin/delivery-hook"), {
    cwd: dir, encoding: "utf8",
    input: JSON.stringify({ cwd: dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
  });
  assert.equal(ls.stdout, "");
  assert.match(ls.stderr, /delivery hook:/);
});

test("a commit that adds something beyond the approved files is not published", () => {
  const dir = scratchRepo();
  reviewed(dir);
  prompt(dir, "/approve");
  cli(dir, "check");
  execFileSync("git", ["commit", "-qam", "approved"], { cwd: dir });
  // Sneak a file into a commit, then remove it from the working tree so the files still match.
  writeFileSync(join(dir, "extra.txt"), "x\n");
  execFileSync("git", ["add", "extra.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "extra"], { cwd: dir });
  execFileSync("git", ["rm", "-q", "--cached", "extra.txt"], { cwd: dir });
  execFileSync("rm", [join(dir, "extra.txt")]);
  assert.match(cli(dir, "status").out, /Phase: ready/);
  assert.match(bash(dir, "git push").hookSpecificOutput.permissionDecisionReason, /differs from the approved files \(extra.txt\)/);
});

test("an AC that is the checks themselves is proven by delivery check", () => {
  const dir = scratchRepo();
  cli(dir, "start", "--ticket", "SHIELD-1", "--ac", "Dead code removed", "--ac", "lint, test and build pass");
  writeFileSync(join(dir, "a.txt"), "two\n");
  cli(dir, "evidence", "AC1", "no imports left (grep)");
  assert.match(cli(dir, "evidence", "AC2", "--by-checks").out, /proven by `delivery check`.*npm run lint · npm run test/);
  assert.match(cli(dir, "review").out, /◦ AC2: lint, test and build pass\s+by checks, pending/);
  prompt(dir, "/approve");
  cli(dir, "check");
  assert.match(cli(dir, "status").out, /✓ AC2: lint, test and build pass\s+by checks, passed/);
});

/** The SHIELD-2399 layout: the branch moved to the main checkout, the T3 thread stayed in a detached worktree. */
function t3Layout(ticket: string) {
  const main = scratchRepo();
  const worktree = mkdtempSync(join(tmpdir(), "delivery-t3-"));
  execFileSync("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: main });
  reviewed(main, ticket);
  return { main, worktree };
}

test("T3: the user's verdict reaches the contract from a detached worktree", () => {
  const { main, worktree } = t3Layout("T3-1");
  const approved = prompt(worktree, "/delivery:approve looks good");
  assert.match(approved.hookSpecificOutput.additionalContext, new RegExp(`approved T3-1 on the current files of ${main}`));
  assert.match(cli(main, "status").out, /Phase: approved/);
});

test("T3: /approve <TICKET> works from anywhere; without one the open contracts are listed", () => {
  const { main } = t3Layout("T3-2");
  const elsewhere = mkdtempSync(join(tmpdir(), "delivery-nowhere-"));
  const listed = prompt(elsewhere, "/approve").reason;
  assert.match(listed, /Name it: \/approve <TICKET>/);
  assert.match(listed, new RegExp(`T3-2 · feat/export · ${main}`));
  assert.match(prompt(elsewhere, "/approve t3-2 ship it").hookSpecificOutput.additionalContext, /approved T3-2[\s\S]*ship it/);
});

test("T3: a session that ran the CLI gets its nudges in its own worktree; other threads do not", () => {
  const { main, worktree } = t3Layout("T3-3");
  writeFileSync(join(main, "a.txt"), "three\n"); // withdraws the review: implementing again
  assert.equal(hook(worktree, { hook_event_name: "Stop", session_id: "other-thread" }), undefined);
  hook(worktree, { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: `cd ${main} && delivery status` } });
  assert.match(hook(worktree, { hook_event_name: "Stop", session_id: "s1" }).reason, /T3-3/);
  assert.match(hook(worktree, { hook_event_name: "SessionStart", session_id: "s1" }).hookSpecificOutput.additionalContext, new RegExp(`checked out at ${main}`));
});

test("T3: publishing the contract's branch from a detached worktree is gated", () => {
  const { main, worktree } = t3Layout("T3-4");
  assert.ok(denied(bash(worktree, "git push origin feat/export")));
  assert.ok(denied(bash(worktree, "git push origin HEAD:refs/heads/feat/export")));
  assert.ok(denied(hook(worktree, { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: `cd ${main} && gh pr create --fill` } })));
  const nowhere = mkdtempSync(join(tmpdir(), "delivery-nowhere-"));
  assert.ok(denied(tool(nowhere, "mcp__github__create_pull_request", { owner: "o", repo: "r", head: "feat/export", base: "main" })));
  assert.equal(tool(nowhere, "mcp__github__create_pull_request", { owner: "o", repo: "r", head: "other", base: "main" }), undefined);
  assert.equal(bash(worktree, "git push origin some-other-branch"), undefined);
});

test("/delivery-reset and /delivery-status naming an unknown ticket never fall back to the session's contract", () => {
  const dir = scratchRepo();
  assert.equal(cli(dir, "start", "--ticket", "KEEP-1", "--title", "Keep", "--ac", "stays").code, 0);
  const reset = prompt(dir, "/delivery-reset GONE-2");
  assert.match(reset.reason, /No open contract is named GONE-2[\s\S]*KEEP-1 · feat\/export/);
  assert.match(prompt(dir, "/delivery:delivery-status gone-2").reason, /No open contract is named gone-2/);
  assert.match(cli(dir, "status").out, /KEEP-1 — Keep[\s\S]*Phase: implementing/);
  // Without a name, the session's contract is still the target.
  assert.match(prompt(dir, "/delivery-status").reason, /KEEP-1 — Keep/);
  assert.match(prompt(dir, "/delivery-reset").reason, /KEEP-1 \(feat\/export\) archived/);
});
