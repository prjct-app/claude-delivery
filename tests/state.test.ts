import assert from "node:assert/strict";
import test from "node:test";
import {
  addCriterion,
  approve,
  createContract,
  phaseOf,
  recordChecks,
  recordEvidence,
  recordPr,
  requestChanges,
  requestReview,
} from "../src/state.ts";

const base = () => createContract({
  ticket: "CU-1", title: "Export", branch: "feat/x", baseCommit: "c0", tree: "t0", criteria: ["CSV export", " ", "Empty state"],
});

test("criteria come from the ticket, numbered, blanks dropped", () => {
  const contract = base();
  assert.deepEqual(contract.criteria.map((c) => [c.id, c.origin]), [["AC1", "ticket"], ["AC2", "ticket"]]);
  assert.throws(() => createContract({ ticket: "x", title: "", branch: "b", baseCommit: "", tree: "t", criteria: [] }));
});

test("review needs evidence for every AC and a change", () => {
  const contract = recordEvidence(base(), "ac1", "export button downloads a.csv", "t1");
  assert.throws(() => requestReview(contract, "t1"), /Missing: AC2/);
  const complete = recordEvidence(contract, "AC2", "empty list shows message", "t1");
  assert.throws(() => requestReview(complete, "t0"), /Nothing has changed/);
  assert.equal(phaseOf(requestReview(complete, "t1"), "t1"), "review");
});

test("phases follow the tree: any change withdraws review and invalidates approval", () => {
  const reviewed = requestReview(recordEvidence(recordEvidence(base(), "AC1", "a", "t1"), "AC2", "b", "t1"), "t1");
  assert.equal(phaseOf(reviewed, "t2"), "implementing");
  const approved = approve(reviewed, "t1", undefined, false);
  assert.equal(phaseOf(approved, "t1"), "approved");
  assert.equal(phaseOf(approved, "t2"), "implementing");
  const failed = recordChecks(approved, "t1", [{ command: "pnpm run test", exitCode: 1, ms: 1 }], "log");
  assert.equal(phaseOf(failed, "t1"), "approved");
  const passed = recordChecks(approved, "t1", [{ command: "pnpm run test", exitCode: 0, ms: 1 }], "log");
  assert.equal(phaseOf(passed, "t1"), "ready");
  assert.equal(phaseOf(recordPr(passed, "https://github.com/o/r/pull/1"), "t1"), "pr-open");
  assert.equal(phaseOf(passed, "t3"), "implementing");
});

test("change requests send the work back and are kept", () => {
  const reviewed = requestReview(recordEvidence(recordEvidence(base(), "AC1", "a", "t1"), "AC2", "b", "t1"), "t1");
  const changed = requestChanges(reviewed, "wrong delimiter", "t1");
  assert.equal(phaseOf(changed, "t1"), "implementing");
  assert.equal(changed.changes.at(-1)?.reason, "wrong delimiter");
});

test("the agent adds criteria only while implementing, marked as its own", () => {
  const added = addCriterion(base(), "Handles 10k rows", "t1");
  assert.deepEqual(added.criteria.at(-1), { id: "AC3", text: "Handles 10k rows", origin: "agent" });
  const evidenced = ["AC1", "AC2", "AC3"].reduce((c, id) => recordEvidence(c, id, "seen", "t1"), added);
  const reviewed = requestReview(evidenced, "t1");
  assert.throws(() => addCriterion(reviewed, "late", "t1"), /only while implementing/);
});
