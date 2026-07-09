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
