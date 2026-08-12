// The connector code author sees only the chat agent's instructions plus the
// target schema — never the workflow. So when a target field holds a related
// entity/value object, the codegen prompt must carry the related schema's example
// values as the ALLOWED vocabulary, or fabricated (simulate-content) rows invent
// plausible lookalikes the model never defined ("Compliance Requirement" when the
// model's RegulationType allows only Generic Product Requirement | Business
// Requirement | Local).

import { describe, it, expect } from "vitest";
import { buildConnectorPrompt, type RelatedSchema } from "../../src/packs/connector/codegen.js";
import { relatedSchemasFor } from "../../src/packs/connector/orchestrate.js";
import { getOntology } from "../../src/ontology/model.js";
import { modelHarness, REGULATED_DEMAND_MODEL } from "../helpers/po-model.js";

function demandInput(related: RelatedSchema[]) {
  const model = modelHarness(REGULATED_DEMAND_MODEL);
  const target = model.run(() => getOntology().entity("MarketDemand")!);
  return { target, targetKind: "entity" as const, instructions: "simulate ~20 rows", credentialKeys: [], related };
}

describe("relatedSchemasFor", () => {
  it("resolves each relatedEntity field to its schema, tagged entity vs valueObject, deduped", () => {
    const model = modelHarness(REGULATED_DEMAND_MODEL);
    const related = model.run(() => relatedSchemasFor(getOntology().entity("MarketDemand")!));
    expect(related.map((r) => [r.name, r.kind])).toEqual([
      ["RegulationType", "entity"],
      ["RegulationStatus", "valueObject"],
    ]);
    expect(related[0]!.schema.fields[0]!.exampleData).toEqual([
      "Generic Product Requirement", "Business Requirement", "Local",
    ]);
  });
});

describe("buildConnectorPrompt related schemas", () => {
  it("renders the related schemas' example values as the allowed vocabulary", () => {
    const model = modelHarness(REGULATED_DEMAND_MODEL);
    const related = model.run(() => relatedSchemasFor(getOntology().entity("MarketDemand")!));
    const prompt = buildConnectorPrompt(demandInput(related));
    // The field line points at the related section…
    expect(prompt).toContain("[holds a RegulationType value object — see Related schemas]");
    // …which carries the model's allowed values for both related kinds…
    expect(prompt).toContain("## Related schemas");
    expect(prompt).toContain('id: string — allowed values: "Generic Product Requirement" | "Business Requirement" | "Local"');
    expect(prompt).toContain('status: string — allowed values: "Inforce" | "Proposed"');
    // …and the fabrication rule that pins values to that vocabulary.
    expect(prompt).toContain("FABRICATED data for a field with a Related schema must use ONLY");
  });

  it("omits the related section and its rule when the target has no related fields", () => {
    const prompt = buildConnectorPrompt(demandInput([]));
    expect(prompt).not.toContain("## Related schemas");
    expect(prompt).not.toContain("FABRICATED data for a field with a Related schema");
  });

  it("dedupes a field's own example values instead of showing only the first", () => {
    const prompt = buildConnectorPrompt(demandInput([]));
    expect(prompt).toContain('status: string — e.g. "NEW", "ASSESSED"');
  });
});

// Earlier events routinely shape what a connector must pull, so every prompt
// documents the ctx.readTable snapshot — and names the workflow's tables when
// the caller resolves them, so the author AI reads live data instead of baking
// a stale copy of another table's rows into the code.
describe("buildConnectorPrompt workflow-table snapshots", () => {
  it("documents ctx.tables/ctx.readTable and names the caller-resolved tables", () => {
    const prompt = buildConnectorPrompt({ ...demandInput([]), workflowTables: ["Quarter", "Meeting", "Insights"] });
    expect(prompt).toContain("ctx.readTable(name)");
    expect(prompt).toContain("read-only snapshots: Quarter, Meeting, Insights");
    expect(prompt).toContain('read it at RUN TIME via ctx.readTable("<Table>")');
    expect(prompt).toContain("NEVER bake a copied snapshot");
  });

  it("still documents the capability generically when no table names are resolved", () => {
    const prompt = buildConnectorPrompt(demandInput([]));
    expect(prompt).toContain("ctx.readTable(name)");
    expect(prompt).not.toContain("read-only snapshots:");
  });
});

// Event-chain (FK) guidance mirrors the cycle sections: model-conditional, and
// grounded in the parent table's REAL id values so the author AI matches the
// exact format case correlation will compare against (Order.customerId must
// hold a value that EXISTS as Customer.id, byte-for-byte, or the chain breaks).
describe("buildConnectorPrompt event-chain (FK) links", () => {
  it("an FK child gets chain rules with the parent's real id format", () => {
    const prompt = buildConnectorPrompt({
      ...demandInput([]),
      fkLinks: [{ field: "customerId", target: "Customer", targetIdExamples: ["cust-1", "cust-2"] }],
    });
    expect(prompt).toContain("## Event-chain links");
    expect(prompt).toContain('"customerId" must hold an id that EXISTS in the Customer table');
    expect(prompt).toContain("byte-for-byte the value of Customer.id");
    expect(prompt).toContain('Real Customer.id values right now: "cust-1", "cust-2"');
    expect(prompt).toContain('ctx.readTable("<ParentTable>")');
  });

  it("an empty parent table still gets the format rules, just without samples", () => {
    const prompt = buildConnectorPrompt({
      ...demandInput([]),
      fkLinks: [{ field: "customerId", target: "Customer", targetIdExamples: [] }],
    });
    expect(prompt).toContain("## Event-chain links");
    expect(prompt).not.toContain("Real Customer.id values");
  });

  it("a target with no FK fields gets no chain section", () => {
    expect(buildConnectorPrompt(demandInput([]))).not.toContain("Event-chain links");
  });

  it("a period-scoped parent adds the correct-period rule; a plain parent gets none", () => {
    const plain = buildConnectorPrompt({
      ...demandInput([]),
      fkLinks: [{ field: "customerId", target: "Customer", targetIdExamples: [] }],
    });
    expect(plain).not.toContain("reference the parent row for the CORRECT period");
    const cyclic = buildConnectorPrompt({
      ...demandInput([]),
      fkLinks: [{ field: "quarterId", target: "Quarter", targetIdExamples: ["ACME@2026Q3"], parentIsCycle: true }],
    });
    expect(cyclic).toContain("Quarter is period-scoped (one row per subject per period)");
    expect(cyclic).toContain("reference the parent row for the CORRECT period");
  });
});

// Re-run economics are unconditional for entity targets: every connector re-runs
// (manual pulls + scheduled polling) and ingest skips already-present ids, so the
// author must self-gate expensive derived rows (incremental via ctx.readTable of
// its OWN target table) instead of re-paying per-row AI/API cost each run. Value
// objects carry no connector-supplied id, so they get no id-diff guidance.
describe("buildConnectorPrompt re-run behavior", () => {
  it("an entity target gets the re-run section with incremental self-gating against its own table", () => {
    const prompt = buildConnectorPrompt(demandInput([]));
    expect(prompt).toContain("## Re-runs");
    expect(prompt).toContain("is SKIPPED — never updated, never duplicated");
    expect(prompt).toContain('ctx.readTable("MarketDemand")');
    expect(prompt).toContain("INCREMENTAL is the default whenever each row is EXPENSIVE to produce");
    // Backlog progress: the limit is taken AFTER the already-done filter, or a
    // limit-first module re-examines the same first slice forever and stalls.
    expect(prompt).toContain("Apply ctx.limit AFTER excluding already-present items");
    // The gate degrades silently past the snapshot cap — the author is warned.
    expect(prompt).toContain("do not trust the diff alone");
    expect(prompt).toContain("REGENERATE-ALL only when the instructions explicitly ask for it");
    // Pass-through pulls are exempt — dedup by stable id suffices.
    expect(prompt).toContain("pass-through pull from a system of record needs no gating");
    // The _provisional merge exception exists only for cycle tables — a plain
    // entity prompt must not mention a column that never occurs on its target.
    expect(prompt).not.toContain("_provisional");
  });

  it("a cycle TARGET's re-run rules bind to the cycle section: subject+period diff, _provisional counts as missing", () => {
    const prompt = buildConnectorPrompt({
      ...demandInput([]),
      cycle: { subjectFields: ["hubspotCompanyId"], periodField: "quarter", granularity: "quarter", periodExample: "2026Q3" },
    });
    expect(prompt).toContain("compare by its subject + period fields instead of id");
    expect(prompt).toContain("treat rows marked _provisional as MISSING");
    expect(prompt).toContain("it IS merged");
  });

  it("a value-object target gets no re-run section", () => {
    const prompt = buildConnectorPrompt({ ...demandInput([]), targetKind: "valueObject" });
    expect(prompt).not.toContain("## Re-runs");
  });
});

// Cycle guidance is model-conditional: the builder AI is told about recurring
// cycles ONLY when the target is (or links into) a period-scoped aggregate —
// it never judges cycle-ness itself, and non-cycle prompts carry none of it.
describe("buildConnectorPrompt cycle guidance", () => {
  const base = () => demandInput([]);

  it("a period-scoped target gets the recurring-cycle rules (verbatim subject, engine-owned id, exact period format)", () => {
    const prompt = buildConnectorPrompt({
      ...base(),
      cycle: { subjectFields: ["hubspotCompanyId"], periodField: "quarter", granularity: "quarter", periodExample: "2026Q3" },
    });
    expect(prompt).toContain("## Recurring-cycle table (period-scoped)");
    expect(prompt).toContain("ONE ROW PER SUBJECT PER PERIOD");
    expect(prompt).toContain("hubspotCompanyId + quarter (quarter)");
    expect(prompt).toContain('formatted EXACTLY like "2026Q3"');
    expect(prompt).toContain("Do NOT compose the row id");
    // The generic "derive a deterministic id" rule is replaced for cycle targets.
    expect(prompt).not.toContain("derive a deterministic one");
  });

  it("a cycle CHILD target gets the membership rules (byte-for-byte subject values, no period filtering)", () => {
    const prompt = buildConnectorPrompt({
      ...base(),
      cycleChild: [{ target: "Quarter", pairs: [{ child: "companyId", subject: "hubspotCompanyId" }], granularity: "quarter", periodExample: "2026Q3" }],
    });
    expect(prompt).toContain("## Cycle membership");
    expect(prompt).toContain('"companyId": must carry the Quarter table\'s hubspotCompanyId value VERBATIM');
    expect(prompt).toContain("do NOT filter rows read from the source to the current quarter");
    // GENERATED content lands in the CORRECT period: per-(subject, period) ids by
    // default, so next quarter's rows aren't skipped as already present — and the
    // period stays out of the subject field.
    expect(prompt).toContain('"<subject>@2026Q3"');
    expect(prompt).toContain("per (subject, quarter)");
    expect(prompt).toContain('the period never leaks into "companyId"');
  });

  it("a plain target gets no cycle guidance at all", () => {
    const prompt = buildConnectorPrompt(base());
    expect(prompt).not.toContain("Recurring-cycle table");
    expect(prompt).not.toContain("Cycle membership");
  });
});
