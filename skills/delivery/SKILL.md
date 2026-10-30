---
name: delivery
description: Work a ticket with acceptance criteria (ClickUp, Jira, Linear, GitHub issue, Markdown or pasted) under a delivery contract. Use when the user hands over a ticket, issue or story to implement, or when a Delivery contract is active on the branch.
---

# Delivery contract

The user's flow: ticket with ACs → you implement until every AC is met → the user reviews → changes or approval → full local checks → PR. The `delivery` CLI records your side; hooks enforce the rest.

The CLI is `delivery`; if it is not on PATH, use `${CLAUDE_PLUGIN_ROOT}/bin/delivery`. Run it from inside the repository. If the user invoked this skill with a ticket reference (`$ARGUMENTS`), that is the ticket to work.

## Start
1. Read the ticket with whatever connector holds it. Copy its acceptance criteria verbatim, one `--ac` each. If it has none, ask the user for them instead of inventing them.
2. Create a branch for the ticket if you are on the default branch.
3. `delivery start --ticket <id> --title "<title>" --url <url> --source <tool> --ac "<AC 1>" --ac "<AC 2>"`

## Implement
- Work until every AC is met. For each one: `delivery evidence AC<n> "<where it lives and what you observed when you exercised it>"`. Evidence states what you saw, not what you expect.
- An AC that is the checks themselves ("lint, types, tests and build pass"): `delivery evidence AC<n> --by-checks`. `delivery check` proves it after approval; do not run those checks now.
- A criterion the ticket clearly implies but does not state: `delivery ac "<text>"`. It is shown to the user as added by you. Never reinterpret or drop a ticket AC; if one is wrong or impossible, ask.
- Do not run the full checks (whole-project lint/typecheck/test/build) now. They are blocked until approval. Targeted runs, such as one test file, are fine.
- Playwright or a reviewer subagent may help you check behaviour; record what they found with `delivery note playwright "<summary>"` or `delivery note agent-review "<summary>"`. Notes inform the user; they never approve.

## Review
- `delivery review` once every AC has evidence. Show its output to the user and stop. They answer `/approve` or `/changes <reason>`.
- Do not edit anything while waiting: any change withdraws the review request. Evidence, criteria and notes are frozen outside implementation.

## After approval
- `delivery check` runs the configured checks on the approved tree and records the exit codes. Give it a long timeout (up to 10 minutes) or run it in the background.
- If a check fails, fixing it is a change: fix, update evidence, `delivery review` again.
- When the checks pass, commit exactly the approved files in its own command, then push and open the PR. The gate compares the commit with what was approved. Merging is the user's call.

## Rules
- Only the user approves, requests changes or resets the contract. There is no CLI command for those, and you never send those slash commands to any session, thread or `claude` process.
- The contract store and `.claude/delivery.json` are off-limits; read state with `delivery status`.
