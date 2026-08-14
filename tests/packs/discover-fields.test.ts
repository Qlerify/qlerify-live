// Source-field discovery (the introspect() seam made real): sample the live
// source through the adapter, record the union of observed field names with
// inferred types + truncated examples on the sidecar, and serve that shape from
// the connector adapter's introspect() — so the build prompt maps the source's
// REAL fields instead of guessing.

import { describe, it, expect, afterAll } from "vitest";
import { discoverSourceFields, inferDiscoveredFields } from "../../src/packs/connector/orchestrate.js";
import { createConnectorAdapter } from "../../src/packs/adapters/connector.js";
import { registerAdapter, unregisterAdapter } from "../../src/packs/registry.js";
import { writeSidecar, readSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { modelHarness } from "../helpers/po-model.js";

const ORDER_MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Shop",
  roles: ["Sales"],
  domainEvents: {
    OrderCreated: {
      event: "Order Created",
      role: "Sales",
      command: { $ref: "#/schemas/commands/PlaceOrder" },
      aggregateRoot: { $ref: "#/schemas/entities/Order" },
    },
  },
  schemas: {
    entities: {
      Order: {
        required: ["id"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "status", dataType: "string", exampleData: ["NEW"] },
          { name: "amount", dataType: "string" },
        ],
      },
    },
    commands: { PlaceOrder: { required: [], fields: [{ name: "amount" }] } },
  },
});

const model = modelHarness(ORDER_MODEL);
const registered: string[] = [];
const sidecars: string[] = [];

function sourceAdapter(id: string, batch: Array<Record<string, unknown>>, fieldMap: Record<string, string> = {}) {
  registerAdapter({
    id, kind: "simulated", boundedContext: "Shop", targetEntity: "Order", mode: "simulated" as const,
    async introspect() { return { entity: "Order", fields: [] }; },
    async mapping() { return fieldMap; },
    async pull() { return { rows: { Order: batch.map((r) => ({ ...r })) }, count: batch.length }; },
    async push() { return { pushed: 0 }; },
    async healthcheck() { return { ok: true }; },
  });
  registered.push(id);
}

function sidecarFor(id: string) {
  writeSidecar({
    id, kind: "connector", boundedContext: "Shop", targetEntity: "Order",
    phase: "built", mode: "live", workflowId: model.workflowId, organizationId: model.orgId,
  });
  sidecars.push(id);
}

afterAll(() => {
  for (const id of registered) unregisterAdapter(id);
  for (const id of sidecars) deleteSidecar(id);
});

describe("inferDiscoveredFields", () => {
  it("unions keys across rows, infers types from the first non-null value, truncates samples", () => {
    const fields = inferDiscoveredFields([
      { id: "a-1", score: 42, ratio: 0.5, active: true, note: null, meta: { k: "v" } },
      { id: "a-2", extra: "only-on-row-2", note: "late value" },
    ]);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(Object.keys(byName)).toEqual(["id", "score", "ratio", "active", "note", "meta", "extra"]);
    expect(byName.score).toMatchObject({ dataType: "integer", sample: "42" });
    expect(byName.ratio).toMatchObject({ dataType: "number", sample: "0.5" });
    expect(byName.active).toMatchObject({ dataType: "boolean", sample: "true" });
    expect(byName.meta).toMatchObject({ dataType: "json", sample: '{"k":"v"}' });
    // A null on the first row doesn't pin the type — the later value does.
    expect(byName.note).toMatchObject({ dataType: "string", sample: '"late value"' });
    const long = inferDiscoveredFields([{ blob: "x".repeat(500) }]);
    expect(long[0]!.sample!.length).toBeLessThanOrEqual(120);
  });

  it("redacts sample VALUES for secret-named fields — name and inferred type survive", () => {
    const fields = inferDiscoveredFields([{ api_key: "sk-live-123", accessToken: "abc", plain: "ok" }]);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.api_key).toEqual({ name: "api_key", dataType: "string" });
    expect(byName.accessToken).toEqual({ name: "accessToken", dataType: "string" });
    expect(byName.plain!.sample).toBe('"ok"');
  });
});

describe("discoverSourceFields", () => {
  it("persists the observed shape on the sidecar and splits model vs extra fields", () =>
    model.run(async () => {
      const id = "discover-basic";
      sidecarFor(id);
      sourceAdapter(id, [
        { id: "o-1", status: "NEW", amount: "10", region: "EMEA", "Deal Size (USD)": 5 },
      ]);
      const r = await discoverSourceFields(id);
      expect(r.sampled).toBe(1);
      expect(r.modelFields).toEqual(["id", "status", "amount"]);
      expect(r.extraFields).toEqual(["region", "Deal Size (USD)"]);
      const cfg = readSidecar(id)!;
      expect(cfg.discoveredFields!.map((f) => f.name)).toEqual(["id", "status", "amount", "region", "Deal Size (USD)"]);
      expect(cfg.discoveredAt).toBeTruthy();
      expect(cfg.phase).toBe("built"); // discovery never regresses the phase ladder
    }));

  it("classifies by the LANDED name when a fieldMap renames source keys — the split mirrors ingest", () =>
    model.run(async () => {
      const id = "discover-fieldmap";
      sidecarFor(id);
      // The source calls it deal_status; the sidecar fieldMap renames it to the
      // declared 'status' column at ingest — so it is NOT an extra.
      sourceAdapter(id, [{ id: "o-m", deal_status: "NEW", region: "EMEA" }], { deal_status: "status" });
      const r = await discoverSourceFields(id);
      expect(r.modelFields).toEqual(["id", "deal_status"]);
      expect(r.extraFields).toEqual(["region"]);
      // discoveredFields keep the RAW source names (what the build prompt maps FROM).
      expect(readSidecar(id)!.discoveredFields!.map((f) => f.name)).toContain("deal_status");
    }));

  it("an empty sample is a clear error, not a silently-emptied shape", () =>
    model.run(async () => {
      const id = "discover-empty";
      sidecarFor(id);
      sourceAdapter(id, []);
      await expect(discoverSourceFields(id)).rejects.toThrow(/no rows to sample/);
      expect(readSidecar(id)!.discoveredFields).toBeUndefined();
    }));

  it("the connector adapter's introspect() serves the discovered shape once a sample has run", () =>
    model.run(async () => {
      const id = "discover-introspect";
      sidecarFor(id);
      sourceAdapter(id, [{ id: "o-9", status: "NEW", source_ref: "SRC-9" }]);
      const connectorAdapter = createConnectorAdapter(readSidecar(id)!);
      // Before discovery: the model-schema echo.
      const before = await connectorAdapter.introspect();
      expect(before.fields.map((f) => f.name)).toEqual(["id", "status", "amount"]);
      await discoverSourceFields(id);
      // After: the SOURCE's observed shape, via the fresh sidecar read.
      const after = await connectorAdapter.introspect();
      expect(after.fields.map((f) => f.name)).toEqual(["id", "status", "source_ref"]);
    }));
});
