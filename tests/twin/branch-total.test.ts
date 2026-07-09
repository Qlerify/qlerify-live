// Per-run step totals on a BRANCHED model. The list view's progress column used
// the whole model's event count as every run's denominator, so a case on a
// 10-step branch of an 18-event model read "7/18" forever. branchTotal picks
// the source→sink chain through the `follows` DAG that best matches the run's
// fired events — most fired events on the chain first, longest chain as the
// tiebreaker — so that case reads "7/10" instead.

import { describe, expect, it } from "vitest";
import { getOntology } from "../../src/ontology/model.js";
import { branchTotal } from "../../src/twin/sim.js";
import { modelHarness } from "../helpers/po-model.js";

// A miniature of the real shape: a shared spine, a fork into two ALTERNATIVE
// branches of different lengths, and a merge back for the closing steps.
//   Start → Fork → BrApproved → BrDone ───────────────→ Verify → End   (6 steps)
//                → GprApproved → GprMid → GprDone ────→ Verify → End   (7 steps)
const BRANCHED_MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Compliance",
  roles: ["Analyst"],
  domainEvents: {
    Start: {
      event: "Regulation Identified",
      role: "Analyst",
      command: { $ref: "#/schemas/commands/CreateCase" },
      aggregateRoot: { $ref: "#/schemas/entities/Case" },
    },
    Fork: { event: "Effort Analyzed", role: "Analyst", follows: [{ $ref: "#/domainEvents/Start" }] },
    BrApproved: { event: "BR Approved", role: "Analyst", follows: [{ $ref: "#/domainEvents/Fork" }] },
    BrDone: { event: "BR Implemented", role: "Analyst", follows: [{ $ref: "#/domainEvents/BrApproved" }] },
    GprApproved: { event: "GPR Approved", role: "Analyst", follows: [{ $ref: "#/domainEvents/Fork" }] },
    GprMid: { event: "GPR Applicability Identified", role: "Analyst", follows: [{ $ref: "#/domainEvents/GprApproved" }] },
    GprDone: { event: "GPR Deployed", role: "Analyst", follows: [{ $ref: "#/domainEvents/GprMid" }] },
    Verify: {
      event: "Compliance Verified",
      role: "Analyst",
      follows: [{ $ref: "#/domainEvents/BrDone" }, { $ref: "#/domainEvents/GprDone" }],
    },
    End: { event: "Product Launched", role: "Analyst", follows: [{ $ref: "#/domainEvents/Verify" }] },
  },
  schemas: {
    entities: {
      Case: {
        required: ["id"],
        fields: [{ name: "id", dataType: "string" }],
      },
    },
    commands: {
      CreateCase: { required: [], fields: [] },
    },
  },
});

const ref = (k: string) => `#/domainEvents/${k}`;
const fired = (...keys: string[]) => new Set(keys.map(ref));

describe("branchTotal — a run's total is its own branch's path length", () => {
  const h = modelHarness(BRANCHED_MODEL);

  it("a run that hasn't committed to a branch reads as the longest open path", () => {
    h.run(() => {
      const ont = getOntology();
      expect(ont.events).toHaveLength(9);
      expect(branchTotal(ont, fired())).toBe(7);
      expect(branchTotal(ont, fired("Start", "Fork"))).toBe(7);
    });
  });

  it("a run on the short branch totals that branch, not the whole model", () => {
    h.run(() => {
      const ont = getOntology();
      expect(branchTotal(ont, fired("Start", "Fork", "BrApproved"))).toBe(6);
      // …and stays 6 all the way to done (6/6, not 6/9).
      expect(branchTotal(ont, fired("Start", "Fork", "BrApproved", "BrDone", "Verify", "End"))).toBe(6);
    });
  });

  it("a run on the long branch totals the long path", () => {
    h.run(() => {
      const ont = getOntology();
      expect(branchTotal(ont, fired("Start", "Fork", "GprApproved"))).toBe(7);
    });
  });

  it("a branch-less model keeps the full event count (the old total)", () => {
    const single = modelHarness(); // PURCHASE_ORDER_MODEL: one linear chain
    single.run(() => {
      const ont = getOntology();
      expect(branchTotal(ont, new Set())).toBe(ont.linearOrder().length);
    });
  });
});
