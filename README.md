# claude-delivery

A Claude Code plugin that turns a ticket's acceptance criteria into a contract for its branch, and keeps the order of work:

```
ticket ACs → implement + evidence per AC → user review → /changes … or /approve → full checks → commit → push / PR → merged
```

It is the Claude Code counterpart of [pi-delivery](https://github.com/prjct-app/pi-delivery), rebuilt around what pi-delivery leaves to the agent's honesty:

- **Only the user approves.** `/approve`, `/changes` and `/delivery-reset` are read from the user's own prompt by a hook. The CLI has no command for them, the slash commands cannot be invoked by the model, and the agent cannot send them to any session, thread or `claude` process (T3 `t3_thread_send`, `delegate_task`, `SendMessage`, `claude -p`). Switching hooks or the plugin off while a contract is open is blocked too.
- **Facts come from git, not from the agent.** Review requests, approval and check results are bound to a hash of the working tree (tracked + untracked, `.gitignore` respected). Any change, by any tool, script or subagent, withdraws the review or invalidates the approval.
- **Checks run after approval, through the CLI.** `delivery check` runs the configured commands and records their exit codes. Whole-project checks are blocked before approval in any spelling (`pnpm build`, `npx next build`, `pnpm vitest run`, `bash -c '…'`); targeted runs (naming a file or path) are not. A check that rewrites files does not count.
- **What is published is what was approved.** Push, `gh pr create` and MCP PR creation need approval and passing checks on the same files, and the commit being published must hold exactly those files. `gh pr merge` (and the MCP merge tool) goes through only when one of the user's last messages asks for a merge; the agent cannot merge on its own. If the gate cannot verify a publish, it denies it.

**T3 worktrees.** A thread may sit in a worktree with a detached HEAD while its branch is checked out elsewhere. Hooks resolve the contract by the session that worked it (recorded when it runs the CLI), then by the cwd's branch, and, for your commands and for publishing, by the only open contract of the same repository. The tree is always taken from the worktree where the branch is checked out, and pushing the contract's branch from another worktree is gated too.

The contract lives in the repository's git dir (`.git/delivery/<branch>.json`), so it follows the branch across sessions, T3 threads and worktrees, and is archived when the PR merges. Updates are serialised, so parallel tool calls do not lose evidence.

## Install

```sh
claude plugin marketplace add prjct-app/claude-delivery
claude plugin install delivery@prjct
```

Requires Node.js 22.18+ (TypeScript runs natively), git, and `gh` for PR merge detection.

## Use

`/delivery CU-123` (or just hand the agent a ticket). You do not have to invoke it: substantial or risky work opens a contract on its own (see [Without a contract](#without-a-contract)). The skill has the agent copy the ticket's ACs verbatim:

```sh
delivery start --ticket CU-123 --title "CSV export" --url … --source jira --ac "…" --ac "…"
delivery evidence AC1 "where it lives and what was observed"
delivery evidence AC4 --by-checks       # an AC that is "lint/types/tests/build pass": proven by delivery check
delivery note playwright "summary"      # review material; never an approval
delivery review                         # then the agent stops
```

You answer:

| Command | Effect |
| --- | --- |
| `/approve [note]` | Approves the exact files put up for review. Refused if they changed since; `--force` approves the current files anyway. |
| `/changes <reason>` | Back to implementation; withdraws any earlier approval. |
| `/delivery-status` | Shows the contract (answered locally, no model call). |
| `/delivery-reset` | Archives the contract (answered locally). |
| `/delivery-skip` | Waives the contract for the rest of this session, when the gate below judged wrongly. |

Each command also takes the ticket first (`/approve SHIELD-2399 looks good`) to name the contract explicitly.

Then the agent runs `delivery check`, commits, and only then can it push and open the PR.

## Without a contract

The agent decides, as in pi-delivery: at session start in a git repository without a contract it is told, once, to open one before substantial or risky work (a ticket, several material ACs, a multi-file feature or refactor, data/auth/payments/migrations) and to skip it for questions, diagnostics and small edits. Without a ticket, the contract is `ADHOC-<slug>` with the outcomes you asked for as its ACs.

When it does not, the first edit is the backstop:

1. A filter without a model call: a ticket reference in your last message or the branch name, a `feat/`/`feature/` branch, or at least 3 changed files counting the one being edited. Below that, the edit goes through.
2. Only then, a small model (`claude -p --model haiku`, no tools, no hooks; ~3 s) reads your last messages and the changed files and answers whether the work needs a contract. If it does, the edit is denied until one is open.

A full check run from the shell without a contract (`pnpm run test`, `tsc --noEmit`, `next build`…) goes through the same filter and judge, since those checks are what a contract defers until approval; targeted runs are not touched. The verdict is kept per message of yours, so later edits cost a file read; a "no" also stands for later messages until a ticket shows up or a few more files change. If the judge cannot answer (no `claude`, timeout), the edit goes through with the reminder. `CLAUDE_DELIVERY_JUDGE_MODEL` changes the model.

## Checks

From `.claude/delivery.json`, which the agent cannot edit:

```json
{ "checks": ["pnpm run lint", "pnpm run type:check", "pnpm run test", "pnpm run build"] }
```

An empty list means the repository has no checks. Without the file, one script per role is taken from `package.json` (`lint`; `typecheck`/`type-check`/`type:check`/`check-types`/`tsc`; `test`; `build`) with the lockfile's package manager. What those scripts run (`next build`, `tsc --noEmit`, `vitest`) is blocked before approval as well. Output goes to `.git/delivery/logs/`; the agent sees a summary and the tail of a failure.

## Cost to the agent

No tools are added; the slash commands are hidden from the model. The skill loads on demand. A repository without a contract adds one line of context at session start; an open contract, ~10 lines. The stop hook nudges at most once per tree state. Hooks cost ~4 ms per tool call when no contract is open anywhere (~30 ms for file edits, which are checked against the gate), ~30 ms while one is. The judge runs at most once per message of yours, and only past the filter.

## Limits

A guardrail, not a sandbox: an agent determined to bypass it can compose a script that writes the store. Outside publishing, hooks fail open so a broken hook never wedges a session. Commands are recognised by parsing; an unusual invocation of a check can slip through.

## Development

```sh
npm install --ignore-scripts
npm run check && npm test
claude --plugin-dir .      # try it without installing
```

License: [MIT](LICENSE).
