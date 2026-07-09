// The chat system prompt must be resolved PER REQUEST from the active
// workflow's model. The original module-load-time SYSTEM_BLOCKS baked the empty
// system model into every chat — the assistant was told "the 0-event workflow"
// for all tenants and reasoned that no lifecycle existed (bit the
// simulate-content doctrine, which derives lifecycle states from the dump).

import { describe, it, expect } from "vitest";
import { systemBlocks } from "../../src/chat/system-prompt.js";
import { modelHarness, REGULATED_DEMAND_MODEL } from "../helpers/po-model.js";

describe("chat system prompt", () => {
  it("resolves the ACTIVE workflow's model, not the module-load-time system model", async () => {
    const model = modelHarness();
    const dump = (await model.run(async () => systemBlocks())).map((b) => b.text).join("\n");
    expect(dump).toContain("The 1-event workflow");
    expect(dump).toContain("Purchase Order Created");
    expect(dump).toContain("PurchaseOrder");
  });

  it("off-request (system context) still yields the empty dump", () => {
    const dump = systemBlocks().map((b) => b.text).join("\n");
    expect(dump).toContain("The 0-event workflow");
  });

  it("is memoized per model: same workflow → identical block array (prompt-cache-stable)", async () => {
    const model = modelHarness();
    const [a, b] = await model.run(async () => [systemBlocks(), systemBlocks()]);
    expect(a).toBe(b);
  });

  it("renders related-schema fields as closed sets with the related item's example values", async () => {
    const model = modelHarness(REGULATED_DEMAND_MODEL);
    const dump = (await model.run(async () => systemBlocks())).map((b) => b.text).join("\n");
    // Related ENTITY: the vocabulary lives on RegulationType.id.
    expect(dump).toContain('regulationType → RegulationType { id: "Generic Product Requirement" | "Business Requirement" | "Local" } (closed set — ONLY these values)');
    // Related VALUE OBJECT: same treatment.
    expect(dump).toContain('regulationStatus → RegulationStatus { status: "Inforce" | "Proposed" } (closed set — ONLY these values)');
    // Status ladder: deduped, in model order (drives the lifecycle spread).
    expect(dump).toContain('status values (lifecycle order): "NEW" | "ASSESSED"');
  });
});
