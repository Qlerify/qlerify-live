// The trigger-rule compiler prompt (pure — no I/O, no LLM): the GWTs verbatim,
// the operator's condition, sibling disambiguation, real sample rows, the sync/
// zero-import contract, and the period vocabulary for "current quarter". Plus
// the connector-builder prompt's new events section (GWTs finally reach it).

import { describe, it, expect } from "vitest";
import { buildRulePrompt, type RuleGenInput } from "../../src/packs/connector/rules-codegen.js";
import { buildConnectorPrompt } from "../../src/packs/connector/codegen.js";
import type { EntitySchema } from "../../src/ontology/model.js";

const DEAL: EntitySchema = {
  name: "Deal",
  required: ["id"],
  fields: [
    { name: "id", dataType: "string" },
    { name: "category", dataType: "string" },
    { name: "amount", dataType: "number" },
    { name: "dealDate", dataType: "date" },
  ],
} as unknown as EntitySchema;

function input(over: Partial<RuleGenInput> = {}): RuleGenInput {
  return {
    event: {
      key: "UpsellDealCreated",
      name: "Upsell Deal Created",
      ref: "#/domainEvents/UpsellDealCreated",
      commandName: "CategorizeDeal",
      acceptanceCriteria: ["Given a deal, When its category is upsell and the amount exceeds 20000, Then an upsell deal is recorded"],
    },
    siblings: [{ key: "CrossSellDealCreated", name: "Cross Sell Deal Created", condition: "deal category is cross sell" }],
    condition: "upsell deals over 20 000 USD in the current quarter",
    target: DEAL,
    sampleRows: [{ id: "d1", category: "upsell", amount: "25000", dealDate: "2026-07-20" }],
    workflowTables: ["Deal", "Company"],
    ...over,
  };
}

describe("buildRulePrompt", () => {
  it("carries the GWTs verbatim, the operator condition, and the target field shapes", () => {
    const p = buildRulePrompt(input());
    expect(p).toContain("Given a deal, When its category is upsell and the amount exceeds 20000");
    expect(p).toContain("upsell deals over 20 000 USD in the current quarter");
    expect(p).toContain("amount: number");
    expect(p).toContain('"amount":"25000"'); // real row: numbers may arrive as strings
  });

  it("disambiguates sibling outcomes with their conditions", () => {
    const p = buildRulePrompt(input());
    expect(p).toContain("Cross Sell Deal Created — fires when: deal category is cross sell");
    expect(p).toContain("must NOT fire this rule");
  });

  it("pins the contract: synchronous, zero imports, evidence citing values, reserved previous param", () => {
    const p = buildRulePrompt(input());
    expect(p).toContain("export function detect(row, ctx, previous)");
    expect(p).toContain("SYNCHRONOUS and PURE");
    expect(p).toContain("no imports of any kind");
    expect(p).toContain("evidence must cite the DECIDING values");
    expect(p).toContain("`previous` is reserved");
    expect(p).toContain("Output ONLY the JavaScript module source");
  });

  it("teaches the period vocabulary — 'current quarter' is ctx.period against ctx.now", () => {
    const p = buildRulePrompt(input());
    expect(p).toContain('ctx.period.of(rowDate, "quarter") === ctx.period.of(ctx.now, "quarter")');
    expect(p).toContain("Tables: Deal, Company");
  });

  it("a self-heal turn appends the error report", () => {
    const p = buildRulePrompt(input({ errorReport: "fired for d2 (cross sell) — must not" }));
    expect(p).toContain("Your previous attempt was WRONG");
    expect(p).toContain("fired for d2 (cross sell)");
  });
});

describe("buildConnectorPrompt — the events (GWT) section", () => {
  const base = {
    target: DEAL,
    targetKind: "entity" as const,
    instructions: "hubspot deals",
    credentialKeys: [],
  };

  it("lists the target's lifecycle events with criteria, siblings, and satellites", () => {
    const p = buildConnectorPrompt({
      ...base,
      events: [
        { key: "DealCreated", name: "Deal Created", commandName: "PlaceDeal", acceptanceCriteria: ["Given …, Then a deal exists"] },
        {
          key: "UpsellDealCreated", name: "Upsell Deal Created", commandName: "CategorizeDeal",
          acceptanceCriteria: ["Given a deal, When upsell, Then recorded"], siblings: ["Cross Sell Deal Created"],
        },
        { key: "DealBooked", name: "Deal Booked", commandName: "BookDeal", acceptanceCriteria: [], coupledTo: "Upsell Deal Created" },
      ],
    });
    expect(p).toContain("## Domain events this table drives");
    expect(p).toContain("1. Deal Created (command PlaceDeal)");
    expect(p).toContain("- Given …, Then a deal exists");
    expect(p).toContain("alternative outcome alongside: Cross Sell Deal Created");
    expect(p).toContain("completes with Upsell Deal Created");
    expect(p).toContain("do NOT try to encode event logic in this module");
  });

  it("omits the section entirely when no events are passed (value objects, eventless tables)", () => {
    const p = buildConnectorPrompt(base);
    expect(p).not.toContain("## Domain events this table drives");
  });
});
