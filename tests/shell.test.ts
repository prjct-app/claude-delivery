import assert from "node:assert/strict";
import test from "node:test";
import { located, matchesFullCheck, publishAction, segments, touchesStore, USER_COMMAND, USER_COMMAND_ANYWHERE, writesFile } from "../src/shell.ts";

const checks = ["pnpm run lint", "pnpm run typecheck", "pnpm run test", "pnpm run build"];
const scripts = { lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest run", build: "rm -rf dist && next build" };

test("the lexer respects quotes, escapes and control operators", () => {
  assert.deepEqual(segments(`echo "a && pnpm build" ; git status`), [["echo", "a && pnpm build"], ["git", "status"]]);
  assert.deepEqual(segments("pnpm build 2>&1 | tail -5 &> /dev/null"), [["pnpm", "build"], ["tail", "-5"]]);
  assert.deepEqual(segments("CI=1 timeout -s KILL 600 pnpm test > out.log"), [["pnpm", "test"]]);
  assert.deepEqual(segments(`bash -lc 'cd web && pnpm build'`), [["cd", "web"], ["pnpm", "build"]]);
  assert.deepEqual(segments("echo $(git push)"), [["echo"], ["git", "push"]]);
});

test("whole-project checks match in any spelling", () => {
  assert.equal(matchesFullCheck("pnpm build", checks), "pnpm run build");
  assert.equal(matchesFullCheck("pnpm run test", checks), "pnpm run test");
  assert.equal(matchesFullCheck("cd web && CI=1 timeout 600 pnpm -s lint", checks), "pnpm run lint");
  assert.equal(matchesFullCheck("pnpm install && pnpm typecheck 2>&1 | tail -20", checks), "pnpm run typecheck");
  assert.equal(matchesFullCheck("pnpm --filter web test --coverage", checks), "pnpm run test");
  assert.equal(matchesFullCheck("sh -c 'pnpm build'", checks), "pnpm run build");
});

test("what a script runs is a full check too", () => {
  assert.equal(matchesFullCheck("npx next build", checks, scripts), "pnpm run build");
  assert.equal(matchesFullCheck("pnpm exec tsc --noEmit", checks, scripts), "pnpm run typecheck");
  assert.equal(matchesFullCheck("vitest run", checks, scripts), "pnpm run test");
  assert.equal(matchesFullCheck("eslint .", checks, scripts), "pnpm run lint");
  assert.equal(matchesFullCheck("rm -rf dist", checks, scripts), undefined);
});

test("targeted runs and unrelated commands pass", () => {
  assert.equal(matchesFullCheck("pnpm test src/a.test.ts", checks), undefined);
  assert.equal(matchesFullCheck("pnpm lint --fix src/a.ts", checks), undefined);
  assert.equal(matchesFullCheck("vitest run src/a.test.ts", checks, scripts), undefined);
  assert.equal(matchesFullCheck("eslint src/a.ts", checks, scripts), undefined);
  assert.equal(matchesFullCheck("pnpm install", checks), undefined);
  assert.equal(matchesFullCheck("echo 'pnpm build'", checks), undefined);
  assert.equal(matchesFullCheck(`git commit -m "fix pnpm build"`, checks), undefined);
});

test("npm only treats run and test as scripts", () => {
  assert.equal(matchesFullCheck("npm test", ["npm run test"]), "npm run test");
  assert.equal(matchesFullCheck("npm -w web run test", ["npm run test"]), "npm run test");
  assert.equal(matchesFullCheck("npm build", ["npm run build"]), undefined);
  assert.equal(matchesFullCheck("cargo test", ["cargo test"]), "cargo test");
  assert.equal(matchesFullCheck("cargo test --release", ["cargo test"]), "cargo test");
  assert.equal(matchesFullCheck("cargo test parser", ["cargo test"]), undefined);
});

test("publishing commands are recognised", () => {
  assert.equal(publishAction("git push -u origin feat/x"), "push");
  assert.equal(publishAction("git -C repo push"), "push");
  assert.equal(publishAction("git --no-pager push"), "push");
  assert.equal(publishAction("git add -A && git commit -m x && git push"), "push");
  assert.equal(publishAction(`bash -c "git push"`), "push");
  assert.equal(publishAction("gh pr create --fill"), "pr-create");
  assert.equal(publishAction("gh pr merge 12 --squash"), "pr-merge");
  assert.equal(publishAction(`git commit -m "then git push"`), undefined);
  assert.equal(publishAction("gh pr view 12"), undefined);
});

test("commands are located in the directory they run in", () => {
  const steps = located("cd ../other && git push; git -C /srv/repo push", "/work/app");
  assert.deepEqual(steps.map((s) => s.dir), ["/work/other", "/work/other", "/srv/repo"]);
});

test("store, config and user-command detection", () => {
  assert.equal(touchesStore("cat .git/delivery/feat.json"), true);
  assert.equal(touchesStore("rm ~/.local/state/claude-delivery/active/x"), true);
  assert.equal(touchesStore("git status"), false);
  assert.equal(writesFile("echo '{}' > .claude/delivery.json", ".claude/delivery.json"), true);
  assert.equal(writesFile("cat .claude/delivery.json", ".claude/delivery.json"), false);
  assert.equal(USER_COMMAND.test("/approve looks good"), true);
  assert.equal(USER_COMMAND.test("  /delivery:changes fix it"), true);
  assert.equal(USER_COMMAND.test("Reply /approve when ready"), false);
  assert.equal(USER_COMMAND.test("/approved-list"), false);
  assert.equal(USER_COMMAND_ANYWHERE.test(`echo "/approve" | claude -p`), true);
});

test("a real Next.js project: every way of running its checks is recognised", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "delivery-config-"));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {
    dev: "next dev", build: "next build", lint: "biome check", "lint:fix": "biome check --write",
    "type:check": "tsc --skipLibCheck --noEmit", test: "vitest", "test:e2e": "playwright test",
  } }));
  const config = loadConfig(dir);
  assert.deepEqual(config.checks, ["pnpm run lint", "pnpm run type:check", "pnpm run test", "pnpm run build"]);
  const blocked = (command: string) => matchesFullCheck(command, config.checks, config.scripts);
  for (const command of ["pnpm lint", "pnpm biome check", "pnpm type:check", "pnpm exec tsc --skipLibCheck --noEmit", "npx tsc --noEmit",
    "pnpm test", "pnpm vitest", "pnpm vitest run", "npx vitest run --reporter=dot", "pnpm build", "npx next build"]) {
    assert.ok(blocked(command), command);
  }
  for (const command of ["biome check src/a.ts", "pnpm vitest run src/a.test.ts", "pnpm test src/a.test.ts", "pnpm dev", "pnpm test:e2e", "pnpm install"]) {
    assert.equal(blocked(command), undefined, command);
  }
});
