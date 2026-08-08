// The frontier rule behind the To do tab: OR-join with bypass exclusion (see
// twin/next-actions.ts). These tests pin all four clauses on a branched model
// where each step is a real, independently-fired command — plus one inert
// marker and one coupledTo satellite to pin the exclusions.

import { describe, expect, it } from "vitest";
import { getOntology } from "../../src/ontology/model.js";
import { planNextActions, type CaseState } from "../../src/twin/next-actions.js";
import { modelHarness } from "../helpers/po-model.js";

// The branch-total miniature, upgraded so every step has its own command and
// aggregate root (independent steps, not satellites), with distinct roles:
//   Start → Fork → BrApproved → BrDone ─────────────→ Verify → End(marker)
//               └→ GprApproved → GprMid → GprDone ──→ Verify
//               └→ Note (satellite: no aggregateRoot → coupledTo Fork)
const cmd = (name: string) => ({ $ref: `#/schemas/commands/${name}` });
const root = { $ref: "#/schemas/entities/Case" };
const follows = (...keys: string[]) => keys.map((k) => ({ $ref: `#/domainEvents/${k}` }));
const FRONTIER_MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Compliance",
  roles: ["Sales", "Analyst", "Manager", "Engineer", "Auditor"],
  domainEvents: {
    Start: { event: "Case Opened", role: "Sales", command: cmd("OpenCase"), aggregateRoot: root },
    Fork: { event: "Effort Analyzed", role: "Analyst", command: cmd("AnalyzeEffort"), aggregateRoot: root, follows: follows("Start") },
    Note: { event: "Note Recorded", role: "Analyst", command: cmd("RecordNote"), follows: follows("Fork") },
    BrApproved: { event: "BR Approved", role: "Manager", command: cmd("ApproveBr"), aggregateRoot: root, follows: follows("Fork") },
    BrDone: { event: "BR Implemented", role: "Engineer", command: cmd("ImplementBr"), aggregateRoot: root, follows: follows("BrApproved") },
    GprApproved: { event: "GPR Approved", role: "Manager", command: cmd("ApproveGpr"), aggregateRoot: root, follows: follows("Fork") },
    GprMid: { event: "GPR Applicability Identified", role: "Analyst", command: cmd("IdentifyGpr"), aggregateRoot: root, follows: follows("GprApproved") },
    GprDone: { event: "GPR Deployed", role: "Engineer", command: cmd("DeployGpr"), aggregateRoot: root, follows: follows("GprMid") },
    Verify: { event: "Compliance Verified", role: "Auditor", command: cmd("VerifyCompliance"), aggregateRoot: root, follows: follows("BrDone", "GprDone") },
    // Inert flow marker: no command — shown in the diagram, never fired, never a todo.
    End: { event: "Product Launched", role: "Sales", aggregateRoot: root, follows: follows("Verify") },
  },
  schemas: {
    entities: { Case: { required: ["id"], fields: [{ name: "id", dataType: "string" }] } },
    commands: {
      OpenCase: { required: [], fields: [] }, AnalyzeEffort: { required: [], fields: [] },
      RecordNote: { required: [], fields: [] }, ApproveBr: { required: [], fields: [] },
      ImplementBr: { required: [], fields: [] }, ApproveGpr: { required: [], fields: [] },
      IdentifyGpr: { required: [], fields: [] }, DeployGpr: { required: [], fields: [] },
      VerifyCompliance: { required: [], fields: [] },
    },
  },
});

const ref = (k: string) => `#/domainEvents/${k}`;
const state = (fired: string[], extra: Partial<CaseState> = {}): CaseState => ({
  firedRefs: new Set(fired.map(ref)),
  lastAt: null,
  ...extra,
});
const caseOf = (id: string, s: CaseState) => new Map([[id, s]]);
const keysOf = (actions: ReturnType<typeof planNextActions>) => actions.map((a) => a.eventKey).sort();

describe("planNextActions — OR-join frontier with bypass exclusion", () => {
  const h = modelHarness(FRONTIER_MODEL);

  it("an empty case is ready to start: entry steps only, reason 'start'", () => {
    h.run(() => {
      const actions = planNextActions(getOntology(), caseOf("c1", state([])));
      expect(keysOf(actions)).toEqual(["Start"]);
      expect(actions[0]!.reason).toBe("start");
      expect(actions[0]!.role).toBe("Sales");
      expect(actions[0]!.commandName).toBe("OpenCase");
    });
  });

  it("after a fork, BOTH branch heads are ready (N>1 frontier)", () => {
    h.run(() => {
      const actions = planNextActions(getOntology(), caseOf("c1", state(["Start", "Fork"])));
      expect(keysOf(actions)).toEqual(["BrApproved", "GprApproved"]);
      for (const a of actions) {
        expect(a.reason).toBe("ready");
        expect(a.role).toBe("Manager");
      }
    });
  });

  it("OR-join: a merge step is ready when ONE of its predecessors fired", () => {
    h.run(() => {
      const actions = planNextActions(getOntology(), caseOf("c1", state(["Start", "Fork", "BrApproved", "BrDone"])));
      // Verify follows BrDone AND GprDone; the case committed to the BR branch,
      // so only BrDone has fired — Verify must still be ready. GprApproved is
      // also still open (nothing downstream of it fired).
      expect(keysOf(actions)).toEqual(["GprApproved", "Verify"]);
    });
  });

  it("bypass exclusion: a skipped step disappears once the flow moved past it", () => {
    h.run(() => {
      // GprMid was skipped (its successor GprDone fired anyway — real ingested
      // data does this): it must NOT linger as a todo. Verify becomes ready.
      const actions = planNextActions(getOntology(), caseOf("c1", state(["Start", "Fork", "GprApproved", "GprDone"])));
      expect(keysOf(actions)).toEqual(["BrApproved", "Verify"]);
      // …and BrApproved is only there because the BR branch is genuinely
      // untouched; once Verify fires, both alternatives die (next test).
    });
  });

  it("bypass exclusion: the untaken alternative branch dies when the merge fires", () => {
    h.run(() => {
      const actions = planNextActions(getOntology(), caseOf("c1", state(["Start", "Fork", "BrApproved", "BrDone", "Verify"])));
      // GprApproved/GprMid/GprDone are all ancestors of the fired Verify →
      // bypassed. End is an inert marker → excluded. Frontier is empty: done.
      expect(actions).toEqual([]);
    });
  });

  it("inert markers and coupledTo satellites are never todos", () => {
    h.run(() => {
      const ont = getOntology();
      // The fixture wires Note without an aggregateRoot → the loader couples it
      // to Fork. Sanity-check the premise, then the exclusion.
      expect(ont.eventByKey("Note")?.coupledTo).toBe("Fork");
      const afterFork = planNextActions(ont, caseOf("c1", state(["Start", "Fork"])));
      expect(keysOf(afterFork)).not.toContain("Note");
      const afterVerify = planNextActions(ont, caseOf("c1", state(["Start", "Fork", "BrApproved", "BrDone", "Verify"])));
      expect(keysOf(afterVerify)).not.toContain("End");
    });
  });

  it("multi-fired events count as fired once (set semantics)", () => {
    h.run(() => {
      // firedRefs is a Set: three firings of Fork are the same as one.
      const actions = planNextActions(getOntology(), caseOf("c1", state(["Start", "Fork", "Fork", "Fork"])));
      expect(keysOf(actions)).toEqual(["BrApproved", "GprApproved"]);
    });
  });

  it("a second entry point on an already-active case is not a todo", () => {
    h.run(() => {
      // Start is unfired but the case is active (Fork fired via skip-ahead
      // data)… Start is an ancestor of the fired Fork → bypassed anyway; the
      // 'start' reason only ever applies to completely empty cases.
      const actions = planNextActions(getOntology(), caseOf("c1", state(["Fork"])));
      expect(keysOf(actions)).toEqual(["BrApproved", "GprApproved"]);
      expect(actions.every((a) => a.reason === "ready")).toBe(true);
    });
  });

  it("sorts stale cases first, then oldest activity, with dwell computed", () => {
    h.run(() => {
      const now = new Date("2026-08-07T12:00:00Z");
      const cases = new Map<string, CaseState>([
        ["fresh", state(["Start"], { lastAt: new Date("2026-08-07T09:00:00Z") })],
        ["stale", state(["Start"], { lastAt: new Date("2026-07-28T09:00:00Z") })],
        ["unknown", state(["Start"])],
      ]);
      const actions = planNextActions(getOntology(), cases, { now });
      expect(actions.map((a) => a.caseId)).toEqual(["stale", "fresh", "unknown"]);
      expect(actions[0]!.stale).toBe(true);
      expect(actions[0]!.dwellDays).toBe(10);
      expect(actions[1]!.stale).toBe(false);
      expect(actions[1]!.dwellDays).toBe(0);
      expect(actions[2]!.dwellDays).toBeNull();
      expect(actions[2]!.stale).toBe(false);
    });
  });

  it("staleDays tunes the threshold", () => {
    h.run(() => {
      const now = new Date("2026-08-07T12:00:00Z");
      const c = caseOf("c1", state(["Start"], { lastAt: new Date("2026-08-06T09:00:00Z") }));
      expect(planNextActions(getOntology(), c, { now })[0]!.stale).toBe(false);
      expect(planNextActions(getOntology(), c, { now, staleDays: 1 })[0]!.stale).toBe(true);
    });
  });

  it("the deterministic why names the unblocking predecessor and its age", () => {
    h.run(() => {
      const now = new Date("2026-08-07T12:00:00Z");
      const s = state(["Start", "Fork"], {
        lastAt: new Date("2026-08-03T09:00:00Z"),
        times: new Map([
          [ref("Start"), new Date("2026-08-01T09:00:00Z")],
          [ref("Fork"), new Date("2026-08-03T09:00:00Z")],
        ]),
      });
      const actions = planNextActions(getOntology(), caseOf("c1", s), { now });
      const br = actions.find((a) => a.eventKey === "BrApproved")!;
      expect(br.why).toContain('"Effort Analyzed"');
      expect(br.why).toContain("4 days ago");
      expect(br.why).toContain('"BR Approved"');
      const empty = planNextActions(getOntology(), caseOf("c2", state([])));
      expect(empty[0]!.why).toContain("starts this case");
    });
  });

  it("a linear model behaves like current-step: exactly one ready event", () => {
    const linear = modelHarness(); // PURCHASE_ORDER_MODEL: single create event
    linear.run(() => {
      const ont = getOntology();
      expect(keysOf(planNextActions(ont, caseOf("c1", state([]))))).toEqual(["PurchaseOrderCreated"]);
      expect(planNextActions(ont, caseOf("c1", state(["PurchaseOrderCreated"])))).toEqual([]);
    });
  });

  it("a successor of an unfired satellite is ready once the satellite's ANCHOR fired", () => {
    // Start → Note (satellite: no aggregateRoot → coupledTo Start) → After.
    // Direct command posts fire only the anchor — Note never gets its own
    // EventLog row — so After must unblock via the coupledTo chain, or the
    // case would read as complete with work still open.
    const SATELLITE_MODEL = JSON.stringify({
      version: 1,
      boundedContext: "Ops",
      roles: ["Sales", "Analyst", "Manager"],
      domainEvents: {
        Start: { event: "Case Opened", role: "Sales", command: cmd("OpenCase"), aggregateRoot: root },
        Note: { event: "Note Recorded", role: "Analyst", command: cmd("RecordNote"), follows: follows("Start") },
        After: { event: "Note Reviewed", role: "Manager", command: cmd("ReviewNote"), aggregateRoot: root, follows: follows("Note") },
      },
      schemas: {
        entities: { Case: { required: ["id"], fields: [{ name: "id", dataType: "string" }] } },
        commands: {
          OpenCase: { required: [], fields: [] }, RecordNote: { required: [], fields: [] },
          ReviewNote: { required: [], fields: [] },
        },
      },
    });
    const sat = modelHarness(SATELLITE_MODEL);
    sat.run(() => {
      const ont = getOntology();
      expect(ont.eventByKey("Note")?.coupledTo).toBe("Start"); // fixture premise
      const actions = planNextActions(ont, caseOf("c1", state(["Start"])));
      expect(keysOf(actions)).toEqual(["After"]);
      // …and once the satellite DID fire (sim/derive path), the answer is the same.
      expect(keysOf(planNextActions(ont, caseOf("c1", state(["Start", "Note"]))))).toEqual(["After"]);
    });
  });
});
