import { describe, it, expect, afterAll } from "vitest";
import { applyFieldMap } from "../../src/packs/types.js";
import { synthesizeRow } from "../../src/twin/synthesize.js";
import { createSimulatedAdapter } from "../../src/packs/adapters/simulated.js";
import { registerAdapter, listAdapters } from "../../src/packs/registry.js";
import { ingestPull, reingestAll } from "../../src/packs/ingest.js";
import { readDoc, deleteDoc } from "../../src/packs/connector/journal.js";
import { loadPacks } from "../../src/packs/loadPacks.js";
import { getOntology } from "../../src/ontology/model.js";
import * as store from "../../src/twin/projection-store.js";
import { prisma } from "../../src/db.js";
import { modelHarness } from "../helpers/po-model.js";

const TEST_ENTITY = "PurchaseOrder";

// The model is bound per-workflow (the legacy global .qlerify/workflow.json is
// gone). A fresh workflow id ⇒ a fresh gen__p<hex>_ projection namespace, so this
// file's rows never collide with another file's. Code under test calls
// getOntology() internally, so it must run inside the harness's tenant context.
const model = modelHarness();

afterAll(async () => {
  deleteDoc("test-sim");
  await model.run(async () => {
    const e = getOntology().entity(TEST_ENTITY);
    if (e) await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${store.tableFor(e)}"`);
  });
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
  it("fills every required field, generates an id, and varies by seed", () =>
    model.run(() => {
      const e = getOntology().entity(TEST_ENTITY)!;
      const r1 = synthesizeRow(e, { seed: 1 });
      const r2 = synthesizeRow(e, { seed: 2 });
      for (const req of e.required) expect(r1[req]).toBeDefined();
      expect(typeof r1.id).toBe("string");
      expect(r1.id).not.toBe(r2.id);
    }));
  it("is deterministic for a given seed", () =>
    model.run(() => {
      const e = getOntology().entity(TEST_ENTITY)!;
      expect(synthesizeRow(e, { seed: 99 })).toEqual(synthesizeRow(e, { seed: 99 }));
    }));
});

describe("SimulatedAdapter + ingestPull", () => {
  it("pulls synthesized rows into the gen_ table, stamped with provenance", () =>
    model.run(async () => {
      const adapter = createSimulatedAdapter({ id: "test-sim", boundedContext: "SAP", targetEntity: TEST_ENTITY, seed: 7 });
      registerAdapter(adapter);

      const pulled = await adapter.pull({ limit: 4 });
      expect(pulled.count).toBe(4);
      expect(pulled.rows[TEST_ENTITY]).toHaveLength(4);

      const summary = await ingestPull("test-sim", { limit: 4 });
      expect(summary.inserted).toBe(4);
      expect(summary.mode).toBe("simulated");
      // The whole ingest is timed, and the fetch sub-step can't exceed the total.
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
      expect(summary.fetchMs).toBeGreaterThanOrEqual(0);
      expect(summary.durationMs).toBeGreaterThanOrEqual(summary.fetchMs);

      const rows = await store.findMany(TEST_ENTITY, 50);
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const r of rows) expect(r._provenance).toBe("simulated");

      // Both journaled notes carry a structured duration: the pull note
      // ("Ingested …", ingest time excluding derive) and the derive note
      // ("Derived …", derive's own time). Select by text prefix — a kind filter
      // alone would land on the derive note, and older notes may predate the
      // timing feature (the doc survives on disk between runs) — newest last.
      const doc = readDoc("test-sim");
      const pullNotes = (doc?.notes ?? []).filter((n) => n.kind === "ingested" && n.text.startsWith("Ingested "));
      expect(pullNotes.length).toBeGreaterThanOrEqual(1);
      expect(typeof pullNotes[pullNotes.length - 1].durationMs).toBe("number");
      const deriveNotes = (doc?.notes ?? []).filter((n) => n.kind === "ingested" && n.text.startsWith("Derived "));
      expect(deriveNotes.length).toBeGreaterThanOrEqual(1); // 4 fresh rows always derive events
      expect(typeof deriveNotes[deriveNotes.length - 1].durationMs).toBe("number");
    }));

  it("reingestAll reports how long the whole pass took", () =>
    model.run(async () => {
      const summary = await reingestAll();
      expect(typeof summary.durationMs).toBe("number");
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    }));
});

describe("ingestPull source-supplied dates", () => {
  // Ingested rows carry ONLY timestamps the source recorded: a missing
  // createdAt/updatedAt lands as NULL, never as the ingestion-time default —
  // a fabricated "when we pulled" would sit indistinguishable next to real
  // source dates.
  function fixedRowsAdapter(id: string, rows: Array<Record<string, unknown>>) {
    return {
      id,
      kind: "simulated",
      boundedContext: "SAP",
      targetEntity: TEST_ENTITY,
      mode: "simulated" as const,
      async introspect() { return { entity: TEST_ENTITY, fields: [] }; },
      async mapping() { return {}; },
      async pull() { return { rows: { [TEST_ENTITY]: rows }, count: rows.length }; },
      async push() { return { pushed: 0 }; },
      async healthcheck() { return { ok: true }; },
    };
  }

  it("lands NULL createdAt for rows the source left blank, keeps real source dates — and derived events inherit the honesty", () =>
    model.run(async () => {
      // Unique ids per run: EventLog persists across test runs, and derivation
      // is idempotent on (eventRef, aggregateId) — a reused id would silently
      // skip the emit this test asserts on.
      const suffix = Math.random().toString(36).slice(2, 8);
      const datedId = `po-dated-${suffix}`;
      const undatedId = `po-undated-${suffix}`;
      const po = { projectId: "p1", partNumber: "pn1", qty: 1, supplierId: "s1", status: "DRAFT" };
      registerAdapter(fixedRowsAdapter("test-mixed-dates", [
        { ...po, id: datedId, createdAt: "2023-04-05T06:07:08.000Z" },
        { ...po, id: undatedId },
      ]));
      const summary = await ingestPull("test-mixed-dates", {});
      expect(summary.inserted).toBe(2);

      const withDate = await store.findById(TEST_ENTITY, datedId);
      const withoutDate = await store.findById(TEST_ENTITY, undatedId);
      expect(withDate!.createdAt).toBe("2023-04-05T06:07:08.000Z");
      expect(withoutDate!.createdAt).toBeNull();

      // Persisted derived events: a real source anchor lands with its date and
      // an "estimated" trust stamp (heuristic createdAt, not a declared role);
      // no anchor lands the null pair — businessAt AND businessAtKind NULL,
      // never derivation time.
      const dated = await prisma.eventLog.findFirst({ where: { aggregateId: datedId } });
      const undated = await prisma.eventLog.findFirst({ where: { aggregateId: undatedId } });
      expect(dated!.businessAt!.toISOString().startsWith("2023-04-05")).toBe(true);
      expect(dated!.businessAtKind).toBe("estimated");
      expect(undated!.businessAt).toBeNull();
      expect(undated!.businessAtKind).toBeNull();
    }));

  it("lands NULL dates even when the source supplies none at all — ingestion never stamps its own time", () =>
    model.run(async () => {
      registerAdapter(fixedRowsAdapter("test-no-dates", [{ id: "po-no-source-date" }]));
      const summary = await ingestPull("test-no-dates", { derive: false });
      expect(summary.inserted).toBe(1);

      const row = await store.findById(TEST_ENTITY, "po-no-source-date");
      expect(row!.createdAt).toBeNull();
      expect(row!.updatedAt).toBeNull();
    }));
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
