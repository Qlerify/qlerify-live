import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { applyFieldMap } from "../../src/packs/types.js";
import { synthesizeRow } from "../../src/twin/synthesize.js";
import { createSimulatedAdapter } from "../../src/packs/adapters/simulated.js";
import { registerAdapter, listAdapters } from "../../src/packs/registry.js";
import { ingestPull } from "../../src/packs/ingest.js";
import { loadPacks } from "../../src/packs/loadPacks.js";
import { getOntology } from "../../src/ontology/model.js";
import * as store from "../../src/twin/projection-store.js";
import { prisma } from "../../src/db.js";

const TEST_ENTITY = "PurchaseOrder"; // an arbitrary entity name for the gen_ projection table

// Clean slate: drop any stale gen_ table from a prior session (it may predate the
// _provenance column) so ensureTable recreates it fresh with the current schema.
beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "gen_${TEST_ENTITY}"`);
});
afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "gen_${TEST_ENTITY}"`);
});

describe("applyFieldMap", () => {
  it("renames source keys to model keys, passes unmapped through", () => {
    expect(applyFieldMap({ Supplier: "S1", qty: 3 }, { Supplier: "supplierId" })).toEqual({ supplierId: "S1", qty: 3 });
  });
  it("is identity for an empty map", () => {
    expect(applyFieldMap({ a: 1 }, {})).toEqual({ a: 1 });
  });
});

describe("synthesizeRow", () => {
  it("fills every required field, generates an id, and varies by seed", () => {
    const e = getOntology().entity(TEST_ENTITY)!;
    const r1 = synthesizeRow(e, { seed: 1 });
    const r2 = synthesizeRow(e, { seed: 2 });
    for (const req of e.required) expect(r1[req]).toBeDefined();
    expect(typeof r1.id).toBe("string");
    expect(r1.id).not.toBe(r2.id);
  });
  it("is deterministic for a given seed", () => {
    const e = getOntology().entity(TEST_ENTITY)!;
    expect(synthesizeRow(e, { seed: 99 })).toEqual(synthesizeRow(e, { seed: 99 }));
  });
});

describe("SimulatedAdapter + ingestPull", () => {
  it("pulls synthesized rows into the gen_ table, stamped with provenance", async () => {
    const adapter = createSimulatedAdapter({ id: "test-sim", boundedContext: "SAP", targetEntity: TEST_ENTITY, seed: 7 });
    registerAdapter(adapter);

    const pulled = await adapter.pull({ limit: 4 });
    expect(pulled.count).toBe(4);
    expect(pulled.rows[TEST_ENTITY]).toHaveLength(4);

    const summary = await ingestPull("test-sim", { limit: 4 });
    expect(summary.inserted).toBe(4);
    expect(summary.mode).toBe("simulated");

    const rows = await store.findMany(TEST_ENTITY, 50);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(r._provenance).toBe("simulated");
  });
});

describe("loadPacks", () => {
  it("discovers the SAP pack via dynamic import and registers its adapter", async () => {
    const n = await loadPacks();
    expect(n).toBeGreaterThanOrEqual(1);
    const sap = listAdapters().find((a) => a.boundedContext === "SAP");
    expect(sap).toBeDefined();
    expect(sap!.targetEntity).toBe("PurchaseOrder");
    expect(sap!.kind).toBe("simulated");
  });
});
