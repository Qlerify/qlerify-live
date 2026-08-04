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
      cycleChild: [{ target: "Quarter", pairs: [{ child: "companyId", subject: "hubspotCompanyId" }], granularity: "quarter" }],
    });
    expect(prompt).toContain("## Cycle membership");
    expect(prompt).toContain('"companyId": must carry the Quarter table\'s hubspotCompanyId value VERBATIM');
    expect(prompt).toContain("do NOT filter rows to the current quarter");
  });

  it("a plain target gets no cycle guidance at all", () => {
    const prompt = buildConnectorPrompt(base());
    expect(prompt).not.toContain("Recurring-cycle table");
    expect(prompt).not.toContain("Cycle membership");
  });
});
