// The authored evidence kind: an injected per-event trigger rule replaces the
// static firing predicate for exactly its event — sibling events split by an
// arbitrary condition the heuristics can't express — while payload/date keep the
// event's static SHAPE semantics, satellites keep mirroring their predecessor,
// and a broken rule fails soft AND visible (whole-event static fallback +
// ruleError). Pure planner tests: no DB, no disk, no tenant context.

import { describe, it, expect } from "vitest";
import { loadOntologyFromStrings } from "../../src/ontology/model.js";
import { periodOf, periodStart } from "../../src/twin/period.js";
import {
  planDerivation,
  type AuthoredRuleFn,
  type AuthoredRuleSet,
  type RuleContext,
} from "../../src/twin/derive.js";

// Deals: DealCreated is the create root; UpsellDealCreated / CrossSellDealCreated
// are SIBLINGS (alternative outcomes of one CategorizeDeal command); DealBooked
// has no aggregateRoot of its own → satellite coupled to UpsellDealCreated.
const WORKFLOW = JSON.stringify({
  version: 1,
  boundedContext: "Sales",
  roles: ["Rep"],
  domainEvents: {
    DealCreated: {
      event: "Deal Created",
      role: "Rep",
      command: { $ref: "#/schemas/commands/PlaceDeal" },
      aggregateRoot: { $ref: "#/schemas/entities/Deal" },
    },
    UpsellDealCreated: {
      event: "Upsell Deal Created",
      role: "Rep",
      follows: [{ $ref: "#/domainEvents/DealCreated" }],
      command: { $ref: "#/schemas/commands/CategorizeDeal" },
      aggregateRoot: { $ref: "#/schemas/entities/Deal" },
      acceptanceCriteria: ["Given a deal, When its category is upsell, Then an upsell deal is recorded"],
    },
    CrossSellDealCreated: {
      event: "Cross Sell Deal Created",
      role: "Rep",
      follows: [{ $ref: "#/domainEvents/DealCreated" }],
      command: { $ref: "#/schemas/commands/CategorizeDeal" },
      aggregateRoot: { $ref: "#/schemas/entities/Deal" },
      acceptanceCriteria: ["Given a deal, When its category is cross sell, Then a cross sell deal is recorded"],
    },
    DealBooked: {
      event: "Deal Booked",
      role: "Rep",
      follows: [{ $ref: "#/domainEvents/UpsellDealCreated" }],
      command: { $ref: "#/schemas/commands/BookDeal" },
      // no aggregateRoot → inherits Deal, coupledTo UpsellDealCreated (satellite)
    },
  },
  schemas: {
    entities: {
      Deal: {
        required: ["id"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "status", dataType: "string", exampleData: ["OPEN", "WON"] },
          { name: "category", dataType: "string" },
          { name: "amount", dataType: "number" },
          { name: "notes", dataType: "string" },
          { name: "dealDate", dataType: "date" },
        ],
      },
    },
    commands: {
      PlaceDeal: { required: [], fields: [{ name: "amount" }, { name: "notes" }, { name: "dealDate" }] },
      CategorizeDeal: { required: [], fields: [{ name: "category" }] },
      BookDeal: { required: [], fields: [] },
    },
  },
});

const ont = loadOntologyFromStrings(WORKFLOW, null);
const NOW = new Date("2026-08-12T12:00:00.000Z"); // quarter 2026Q3

function ruleSet(rules: Record<string, AuthoredRuleFn>): AuthoredRuleSet {
  const map = new Map<string, { detect: AuthoredRuleFn; condition?: string; connectorId?: string }>();
  for (const [key, detect] of Object.entries(rules)) map.set(key, { detect, condition: "test", connectorId: "test-conn" });
  return {
    rules: map,
    logs: new Map<string, string[]>(),
    makeCtx(event, entity): RuleContext {
      return {
        event: { key: event.key, ref: event.ref, name: event.name, acceptanceCriteria: event.acceptanceCriteria },
        entity,
        now: NOW,
        period: { of: periodOf, start: periodStart },
        tables: [],
        readTable: () => [],
        log: () => {},
      };
    },
  };
}

function plan(rows: Array<Record<string, unknown>>, authored?: AuthoredRuleSet) {
  const map = new Map<string, Array<Record<string, unknown>>>([["Deal", rows]]);
  return Object.fromEntries(planDerivation(ont, map, undefined, authored).map((p) => [p.key, p]));
}

const DEALS = [
  { id: "d1", category: "upsell", amount: 25000, notes: "expand", dealDate: "2026-07-20T00:00:00.000Z" },
  { id: "d2", category: "cross sell", amount: 9000, notes: "bundle", dealDate: "2026-07-21T00:00:00.000Z" },
  { id: "d3", category: "renewal", amount: 30000, notes: "as-is", dealDate: "2026-01-10T00:00:00.000Z" },
];

describe("planDerivation — authored trigger rules", () => {
  it("sibling events split by an authored condition the static heuristics cannot express", () => {
    const p = plan(DEALS, ruleSet({
      UpsellDealCreated: (row) => ({
        fired: String(row.category) === "upsell",
        evidence: `category=${row.category}`,
      }),
      CrossSellDealCreated: (row) => ({
        fired: String(row.category) === "cross sell",
        evidence: `category=${row.category}`,
      }),
    }));
    expect(p.UpsellDealCreated.kind).toBe("authored");
    expect(p.UpsellDealCreated.fired.map((f) => f.aggregateId)).toEqual(["d1"]);
    expect(p.UpsellDealCreated.fired[0].evidence).toBe("rule: category=upsell");
    expect(p.CrossSellDealCreated.kind).toBe("authored");
    expect(p.CrossSellDealCreated.fired.map((f) => f.aggregateId)).toEqual(["d2"]);
    // d3 (renewal) satisfied neither rule.
    expect(p.UpsellDealCreated.noEvidence).toBe(2);
    // The rule-less create event still runs its static heuristic for all rows.
    expect(p.DealCreated.kind).toBe("create");
    expect(p.DealCreated.fired).toHaveLength(3);
  });

  it("a rule-less sibling keeps its static evidence while the other sibling is authored", () => {
    const p = plan(DEALS, ruleSet({
      CrossSellDealCreated: (row) => ({ fired: String(row.category) === "cross sell" }),
    }));
    expect(p.CrossSellDealCreated.kind).toBe("authored");
    expect(p.CrossSellDealCreated.fired.map((f) => f.aggregateId)).toEqual(["d2"]);
    expect(p.CrossSellDealCreated.fired[0].evidence).toBe("rule: condition met");
    // UpsellDealCreated falls back to the sibling field partition: `category` is
    // claimed by neither sibling's name, so it stays with the earliest sibling —
    // presence evidence fires for EVERY categorized row (exactly the
    // imprecision authored rules exist to replace).
    expect(p.UpsellDealCreated.kind).toBe("fields");
    expect(p.UpsellDealCreated.fired).toHaveLength(3);
  });

  it("compound conditions work: amount > 20000, notes contain a word, current quarter via ctx", () => {
    const p = plan(DEALS, ruleSet({
      UpsellDealCreated: (row, ctx) => {
        const amount = Number(row.amount ?? 0);
        const inQuarter = ctx.period.of(new Date(String(row.dealDate)), "quarter") === ctx.period.of(ctx.now, "quarter");
        const fired = amount > 20000 && /expand/i.test(String(row.notes)) && inQuarter;
        return { fired, evidence: `amount=${amount}, quarter=${ctx.period.of(new Date(String(row.dealDate)), "quarter")}` };
      },
    }));
    // d1: 25000 + "expand" + 2026Q3 ✓. d3: 30000 but 2026Q1 ✗. d2: 9000 ✗.
    expect(p.UpsellDealCreated.fired.map((f) => f.aggregateId)).toEqual(["d1"]);
    expect(p.UpsellDealCreated.fired[0].evidence).toContain("quarter=2026Q3");
  });

  it("an authored predicate keeps the event's static SHAPE: create payload still seeds the ladder's first status", () => {
    const p = plan(DEALS, ruleSet({
      DealCreated: (row) => ({ fired: Number(row.amount ?? 0) > 10000, evidence: `amount=${row.amount}` }),
    }));
    expect(p.DealCreated.kind).toBe("authored");
    expect(p.DealCreated.fired.map((f) => f.aggregateId)).toEqual(["d1", "d3"]);
    for (const f of p.DealCreated.fired) {
      expect(f.payload.status).toBe("OPEN"); // ladder seed = create-shape semantics
      expect(f.payload.id).toBe(f.aggregateId);
    }
  });

  it("a coupled satellite ignores any rule bound to it and keeps mirroring its predecessor", () => {
    const p = plan(DEALS, ruleSet({
      UpsellDealCreated: (row) => ({ fired: String(row.category) === "upsell" }),
      // A rule for the satellite must be IGNORED (satellites complete with their
      // predecessor; they never evaluate a predicate of their own).
      DealBooked: () => ({ fired: true, evidence: "must never run" }),
    }));
    expect(p.DealBooked.kind).not.toBe("authored");
    expect(p.DealBooked.fired.map((f) => f.aggregateId)).toEqual(["d1"]);
    expect(p.DealBooked.fired[0].evidence).toMatch(/completes with Upsell Deal Created/);
  });

  it("a throwing rule falls back to the WHOLE event's static heuristic and records ruleError", () => {
    const p = plan(DEALS, ruleSet({
      UpsellDealCreated: (row) => {
        if (String(row.id) === "d2") throw new Error("boom on d2");
        return { fired: true };
      },
    }));
    // Not a partial mix: d1 (which the rule fired for before d2 threw) is NOT
    // kept — the event re-derived statically (fields kind → fires for all 3).
    expect(p.UpsellDealCreated.kind).toBe("fields");
    expect(p.UpsellDealCreated.ruleError).toContain("boom on d2");
    expect(p.UpsellDealCreated.fired).toHaveLength(3);
  });

  it("an async (Promise-returning) rule is a rule error, not a silent misfire", () => {
    const p = plan(DEALS, ruleSet({
      UpsellDealCreated: ((async () => ({ fired: true })) as unknown) as AuthoredRuleFn,
    }));
    expect(p.UpsellDealCreated.kind).toBe("fields"); // static fallback
    expect(p.UpsellDealCreated.ruleError).toMatch(/synchronously return/);
  });

  it("a rule that MUTATES its row cannot corrupt later events or the payload (isolated copy)", () => {
    const rows = DEALS.map((r) => ({ ...r }));
    const p = plan(rows, ruleSet({
      // A rule that normalizes in place — the classic AI-generated shape.
      DealCreated: (row) => {
        row.category = "MUTATED";
        row.amount = -999;
        return { fired: true, evidence: `cat=${row.category}` };
      },
      UpsellDealCreated: (row) => ({ fired: String(row.category) === "upsell" }),
    }));
    // The later sibling still sees the ORIGINAL category — d1 fires, proving the
    // DealCreated rule's mutation never reached the shared row object.
    expect(p.UpsellDealCreated.fired.map((f) => f.aggregateId)).toEqual(["d1"]);
    // The create event's own payload is built from the untouched row.
    expect(p.DealCreated.fired[0].payload.status).toBe("OPEN");
    // The source rows array is pristine.
    expect(rows[0].category).toBe("upsell");
    expect(rows[0].amount).toBe(25000);
  });
});
