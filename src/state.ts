// The delivery contract for one branch, and the pure rules that decide its phase.
// A "tree" is the hash of the working tree's content (see git.ts): approval, review requests and
// checks are bound to the tree they saw, so any later change makes them stale without guessing
// which commands mutate files.

export type Phase = "implementing" | "review" | "approved" | "ready" | "pr-open" | "merged";

export interface Criterion {
  id: string;
  text: string;
  /** Criteria from the ticket, or added later by the agent (shown to the reviewer as such). */
  origin: "ticket" | "agent";
  /** `byChecks`: the criterion is the checks themselves (lint/test/build pass); `delivery check` proves it. */
  evidence?: { note: string; at: string; tree: string; byChecks?: boolean };
}

/** Review material that informs the human decision; never an approval by itself. */
export interface ReviewNote {
  kind: string;
  summary: string;
  at: string;
  tree: string;
}

export interface CheckRun {
  command: string;
  exitCode: number;
  ms: number;
}

export interface Contract {
  version: 1;
  ticket: string;
  title: string;
  url?: string;
  source?: string;
  branch: string;
  baseCommit: string;
  startTree: string;
  createdAt: string;
  criteria: Criterion[];
  notes: ReviewNote[];
  reviewRequest?: { tree: string; at: string };
  approval?: { tree: string; at: string; note?: string; forced: boolean };
  changes: Array<{ reason: string; at: string; tree: string }>;
  checks?: { tree: string; at: string; runs: CheckRun[]; passed: boolean; log: string };
  pr?: { url: string; at: string; merged?: boolean };
  /** Tree at which the stop hook last nudged, so it nudges at most once per tree. */
  nudgedTree?: string;
  /** Claude sessions that worked this contract, so their hooks find it wherever the branch lives. */
  sessions?: string[];
}

export function now(): string {
  return new Date().toISOString();
}

export function createContract(input: {
  ticket: string;
  title: string;
  url?: string;
  source?: string;
  branch: string;
  baseCommit: string;
  tree: string;
  criteria: string[];
}): Contract {
  const criteria = input.criteria.map((text) => text.trim()).filter(Boolean);
  if (!input.ticket.trim()) throw new Error("A ticket reference is required.");
  if (criteria.length === 0) throw new Error("At least one acceptance criterion is required.");
  return {
    version: 1,
    ticket: input.ticket.trim(),
    title: input.title.trim(),
    url: input.url?.trim() || undefined,
    source: input.source?.trim() || undefined,
    branch: input.branch,
    baseCommit: input.baseCommit,
    startTree: input.tree,
    createdAt: now(),
    criteria: criteria.map((text, index) => ({ id: `AC${index + 1}`, text, origin: "ticket" })),
    notes: [],
    changes: [],
  };
}

export function phaseOf(contract: Contract, tree: string): Phase {
  if (contract.pr?.merged) return "merged";
  if (contract.approval?.tree === tree) {
    const checks = contract.checks;
    if (checks?.tree === tree && checks.passed) return contract.pr ? "pr-open" : "ready";
    return "approved";
  }
  if (contract.reviewRequest?.tree === tree) return "review";
  return "implementing";
}

export function missingEvidence(contract: Contract): Criterion[] {
  return contract.criteria.filter((criterion) => !criterion.evidence);
}

/** Evidence, criteria and notes are what the user reviews; they are frozen outside implementation. */
function requireImplementing(contract: Contract, tree: string, what: string): void {
  const phase = phaseOf(contract, tree);
  if (phase !== "implementing") {
    throw new Error(`${what} only while implementing; the contract is in ${phase}. ${nextStep(phase)}`);
  }
}

export function addCriterion(contract: Contract, text: string, tree: string): Contract {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("The criterion text cannot be empty.");
  requireImplementing(contract, tree, "Criteria can be added");
  const next = Math.max(0, ...contract.criteria.map((c) => Number(c.id.slice(2)) || 0)) + 1;
  return { ...contract, criteria: [...contract.criteria, { id: `AC${next}`, text: trimmed, origin: "agent" }] };
}

export function recordEvidence(contract: Contract, id: string, note: string, tree: string, byChecks = false): Contract {
  const key = id.trim().toUpperCase();
  if (!contract.criteria.some((c) => c.id === key)) {
    throw new Error(`Unknown criterion ${id}. Known: ${contract.criteria.map((c) => c.id).join(", ")}.`);
  }
  if (!byChecks && !note.trim()) throw new Error("Describe how the criterion is met: where, and what you observed.");
  requireImplementing(contract, tree, "Evidence can be recorded");
  return {
    ...contract,
    criteria: contract.criteria.map((c) => c.id === key
      ? { ...c, evidence: { note: note.trim() || "proven by the full checks after approval", at: now(), tree, ...(byChecks ? { byChecks } : {}) } }
      : c),
  };
}

export function addNote(contract: Contract, kind: string, summary: string, tree: string): Contract {
  if (!kind.trim() || !summary.trim()) throw new Error("A note needs a kind and a summary.");
  requireImplementing(contract, tree, "Notes can be added");
  return { ...contract, notes: [...contract.notes, { kind: kind.trim(), summary: summary.trim(), at: now(), tree }] };
}

export function requestReview(contract: Contract, tree: string): Contract {
  const phase = phaseOf(contract, tree);
  if (phase !== "implementing" && phase !== "review") throw new Error(`Nothing to review: ${nextStep(phase)}`);
  const missing = missingEvidence(contract);
  if (missing.length > 0) {
    throw new Error(`Record evidence before requesting review. Missing: ${missing.map((c) => c.id).join(", ")}.`);
  }
  if (tree === contract.startTree) throw new Error("Nothing has changed since the contract started.");
  return { ...contract, reviewRequest: { tree, at: now() } };
}

/** Only reachable from the user's prompt hook. */
export function approve(contract: Contract, tree: string, note: string | undefined, forced: boolean): Contract {
  return { ...contract, approval: { tree, at: now(), note: note?.trim() || undefined, forced } };
}

/** Only reachable from the user's prompt hook. Also withdraws an earlier approval. */
export function requestChanges(contract: Contract, reason: string, tree: string): Contract {
  return {
    ...contract,
    reviewRequest: undefined,
    approval: undefined,
    checks: undefined,
    changes: [...contract.changes, { reason: reason.trim(), at: now(), tree }],
  };
}

/** `none` is the user's explicit "this repository has no checks" (an empty list in the config). */
export function recordChecks(contract: Contract, tree: string, runs: CheckRun[], log: string, none = false): Contract {
  const passed = runs.every((run) => run.exitCode === 0) && (runs.length > 0 || none);
  return { ...contract, checks: { tree, at: now(), runs, passed, log } };
}

export function recordPr(contract: Contract, url: string): Contract {
  return { ...contract, pr: { url, at: now() } };
}

const NEXT_STEP: Record<Phase, string> = {
  implementing: "Implement until every AC is met, record evidence per AC with `delivery evidence`, then `delivery review` and stop for the user's verdict. Do not run the full checks yet.",
  review: "Waiting for the user: they reply /approve or /changes <reason>. Do not edit files; any change withdraws the review request.",
  approved: "The user approved this exact tree. Run `delivery check` now. Do not edit files; any change invalidates the approval.",
  ready: "Approved and checks passed on this exact tree. You may push and open the PR.",
  "pr-open": "PR open. Merging is the user's call. Further changes need a new review and approval before pushing.",
  merged: "PR merged. The contract is complete.",
};

export function nextStep(phase: Phase): string {
  return NEXT_STEP[phase];
}

export function formatContract(contract: Contract, phase: Phase): string {
  const lines = [
    `Delivery contract · ${contract.ticket}${contract.title ? ` — ${contract.title}` : ""}`,
    `Branch: ${contract.branch} · Phase: ${phase}${contract.url ? ` · ${contract.url}` : ""}`,
    "Acceptance criteria:",
    ...contract.criteria.map((c) => {
      const proven = c.evidence?.byChecks ? contract.checks?.passed && contract.checks.tree === contract.approval?.tree : true;
      const mark = !c.evidence ? "·" : c.evidence.byChecks ? (proven ? "✓" : "◦") : "✓";
      const origin = c.origin === "agent" ? " (added by agent)" : "";
      const lastChange = contract.changes.at(-1)?.at;
      const old = c.evidence && lastChange && c.evidence.at < lastChange ? " (recorded before the last /changes)" : "";
      const label = c.evidence?.byChecks ? `by checks${proven ? ", passed" : ", pending"}` : "evidence";
      return `  ${mark} ${c.id}${origin}: ${c.text}${c.evidence ? `\n      ${label}${old}: ${c.evidence.note}` : ""}`;
    }),
  ];
  if (contract.notes.length > 0) {
    lines.push("Review notes:", ...contract.notes.map((n) => `  - [${n.kind}] ${n.summary}`));
  }
  const lastChange = contract.changes.at(-1);
  if (lastChange && phase === "implementing") lines.push(`Last change request: ${lastChange.reason}`);
  if (contract.checks) {
    const approvedNow = phase === "approved" || phase === "ready" || phase === "pr-open";
    const stale = approvedNow && contract.checks.tree === contract.approval?.tree ? "" : " (stale)";
    lines.push(`Checks: ${contract.checks.passed ? "passed" : "failed"}${stale} — ${contract.checks.runs.map((r) => `${r.command} → ${r.exitCode}`).join(", ")}`);
  }
  if (contract.pr) lines.push(`PR: ${contract.pr.url}${contract.pr.merged ? " (merged)" : ""}`);
  lines.push(`Next: ${nextStep(phase)}`);
  return lines.join("\n");
}
