// Ingest upsert: a re-pulled row whose source values drifted has its CHANGED
// fields updated in place — so state advancement (NEW → SHIPPED) reaches the
// projection and derivation fires the LATER lifecycle events — while unchanged
// rows are skipped untouched, a null never clobbers a stored value, and the row
// keeps the SOURCE's timestamps (an update must not stamp pull-time as business
// time). With a sidecar dateRoles.updated column, an unchanged last-modified
// value short-circuits the field diff entirely (the watermark path).

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { deriveFromData } from "../../src/twin/derive.js";
import { ingestPull } from "../../src/packs/ingest.js";
import { registerAdapter, unregisterAdapter } from "../../src/packs/registry.js";
import { writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import * as store from "../../src/twin/projection-store.js";
import { modelHarness } from "../helpers/po-model.js";

// An Order with a NEW → SHIPPED status ladder: OrderCreated is the create-kind
// root; OrderShipped is status-kind (its name names the ladder's last rung).
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
    OrderShipped: {
      event: "Order Shipped",
      role: "Sales",
      follows: [{ $ref: "#/domainEvents/OrderCreated" }],
      command: { $ref: "#/schemas/commands/ShipOrder" },
      aggregateRoot: { $ref: "#/schemas/entities/Order" },
    },
  },
  schemas: {
    entities: {
      Order: {
        required: ["id"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "status", dataType: "string", exampleData: ["NEW", "SHIPPED"] },
          { name: "amount", dataType: "string" },
          { name: "notes", dataType: "string" },
          { name: "flagged", dataType: "boolean" },
          { name: "lastModified", dataType: "datetime" },
        ],
      },
    },
    commands: {
      PlaceOrder: { required: [], fields: [{ name: "amount" }] },
      ShipOrder: { required: [], fields: [] },
    },
  },
});

const model = modelHarness(ORDER_MODEL);
const registered: string[] = [];
const sidecars: string[] = [];

/** In-memory adapter whose batch is swappable between pulls (a mutating source). */
function orderAdapter(id: string) {
  let batch: Array<Record<string, unknown>> = [];
  registerAdapter({
    id,
    kind: "simulated",
    boundedContext: "Shop",
    targetEntity: "Order",
    mode: "simulated" as const,
    async introspect() { return { entity: "Order", fields: [] }; },
    async mapping() { return {}; },
    async pull() { return { rows: { Order: batch.map((r) => ({ ...r })) }, count: batch.length }; },
    async push() { return { pushed: 0 }; },
    async healthcheck() { return { ok: true }; },
  });
  registered.push(id);
  return { set: (rows: Array<Record<string, unknown>>) => { batch = rows; } };
}

afterAll(async () => {
  for (const id of registered) unregisterAdapter(id);
  for (const id of sidecars) deleteSidecar(id);
  await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  await store.dropProjectionTablesForWorkflow(model.workflowId);
});

async function eventCount(aggregateId: string, eventKey: string): Promise<number> {
  return prisma.eventLog.count({
    where: { workflowId: model.workflowId, aggregateId, eventRef: { contains: eventKey } },
  });
}

describe("ingest upsert — drifted rows update, progression fires later events once", () => {
  it("NEW lands then SHIPPED updates in place, and derive fires Order Shipped exactly once", () =>
    model.run(async () => {
      const src = orderAdapter("upsert-progress");
      src.set([{ id: "ord-1", status: "NEW", amount: "100" }]);
      const first = await ingestPull("upsert-progress", { derive: false });
      expect(first.inserted).toBe(1);
      await deriveFromData();
      expect(await eventCount("ord-1", "OrderCreated")).toBe(1);
      expect(await eventCount("ord-1", "OrderShipped")).toBe(0);

      // The source advanced the order. The re-pull must land the new state…
      src.set([{ id: "ord-1", status: "SHIPPED", amount: "100" }]);
      const second = await ingestPull("upsert-progress", { derive: false });
      expect(second.inserted).toBe(0);
      expect(second.updated).toBe(1);
      expect(second.skipped).toBe(0);
      expect((await store.findById("Order", "ord-1"))!.status).toBe("SHIPPED");

      // …and derivation fires ONLY the later event the new state implies —
      // OrderCreated stays at one (the pairKey idempotency floor).
      await deriveFromData();
      expect(await eventCount("ord-1", "OrderCreated")).toBe(1);
      expect(await eventCount("ord-1", "OrderShipped")).toBe(1);

      // An identical third pull is the unchanged case: skipped, no update.
      const third = await ingestPull("upsert-progress", { derive: false });
      expect(third.updated).toBe(0);
      expect(third.skipped).toBe(1);
      await deriveFromData();
      expect(await eventCount("ord-1", "OrderShipped")).toBe(1);
    }));

  it("a null/absent value never clobbers; createdAt fills once and never moves; source updatedAt lands verbatim", () =>
    model.run(async () => {
      const src = orderAdapter("upsert-noclobber");
      src.set([{ id: "ord-2", status: "NEW", amount: "250", notes: "rush" }]);
      await ingestPull("upsert-noclobber", { derive: false });
      const landed = await store.findById("Order", "ord-2");
      expect(landed!.createdAt).toBeNull(); // absent from the source → NULL, never pull time

      // A partial row: amount omitted, notes null — neither may erase what an
      // earlier pull witnessed. createdAt arrives late → fills the empty slot.
      // updatedAt arrives from the source → lands byte-for-byte (no wall-clock).
      src.set([{
        id: "ord-2", status: "SHIPPED", notes: null,
        createdAt: "2026-01-05T08:00:00.000Z", updatedAt: "2026-02-02T09:30:00.000Z",
      }]);
      const r = await ingestPull("upsert-noclobber", { derive: false });
      expect(r.updated).toBe(1);
      const row = await store.findById("Order", "ord-2");
      expect(row!.status).toBe("SHIPPED");
      expect(String(row!.amount)).toBe("250");
      expect(row!.notes).toBe("rush");
      expect(row!.createdAt).toBe("2026-01-05T08:00:00.000Z");
      expect(row!.updatedAt).toBe("2026-02-02T09:30:00.000Z");

      // createdAt is an origin fact: once present it never moves.
      src.set([{ id: "ord-2", status: "SHIPPED", createdAt: "2027-12-31T00:00:00.000Z" }]);
      const again = await ingestPull("upsert-noclobber", { derive: false });
      expect(again.updated).toBe(0);
      expect(again.skipped).toBe(1);
      expect((await store.findById("Order", "ord-2"))!.createdAt).toBe("2026-01-05T08:00:00.000Z");
    }));

  it("a boolean field re-sent identically does NOT churn as 'updated' every pull (stored as 1/0)", () =>
    model.run(async () => {
      const src = orderAdapter("upsert-bool");
      src.set([{ id: "ord-b", status: "NEW", flagged: true }]);
      await ingestPull("upsert-bool", { derive: false });
      expect((await store.findById("Order", "ord-b"))!.flagged).toBe(1); // boolean → INTEGER 1

      // Re-pulling the identical boolean must converge to "unchanged", not report
      // updated forever (String(true) !== String(1) was the bug).
      src.set([{ id: "ord-b", status: "NEW", flagged: true }]);
      const second = await ingestPull("upsert-bool", { derive: false });
      expect(second.updated).toBe(0);
      expect(second.skipped).toBe(1);
      const third = await ingestPull("upsert-bool", { derive: false });
      expect(third.updated).toBe(0);

      // A genuine boolean flip is still detected.
      src.set([{ id: "ord-b", status: "NEW", flagged: false }]);
      const flip = await ingestPull("upsert-bool", { derive: false });
      expect(flip.updated).toBe(1);
      expect((await store.findById("Order", "ord-b"))!.flagged).toBe(0);
    }));

  it("dateRoles.updated is a watermark: an unchanged last-modified value skips the row without a field diff", () =>
    model.run(async () => {
      const id = "upsert-watermark";
      writeSidecar({
        id, kind: "simulated", boundedContext: "Shop", targetEntity: "Order",
        phase: "built", mode: "simulated", workflowId: model.workflowId,
        organizationId: model.orgId, dateRoles: { updated: "lastModified" },
      });
      sidecars.push(id);
      const src = orderAdapter(id);
      src.set([{ id: "ord-3", status: "NEW", lastModified: "2026-03-01T00:00:00.000Z" }]);
      await ingestPull(id, { derive: false });

      // Same watermark → unchanged by definition: the drifted status must NOT
      // land (proves the diff was short-circuited, not just empty).
      src.set([{ id: "ord-3", status: "SHIPPED", lastModified: "2026-03-01T00:00:00.000Z" }]);
      const held = await ingestPull(id, { derive: false });
      expect(held.updated).toBe(0);
      expect(held.skipped).toBe(1);
      expect((await store.findById("Order", "ord-3"))!.status).toBe("NEW");

      // The watermark moved → the row diffs and the new state lands.
      src.set([{ id: "ord-3", status: "SHIPPED", lastModified: "2026-03-09T00:00:00.000Z" }]);
      const moved = await ingestPull(id, { derive: false });
      expect(moved.updated).toBe(1);
      const row = await store.findById("Order", "ord-3");
      expect(row!.status).toBe("SHIPPED");
      expect(row!.lastModified).toBe("2026-03-09T00:00:00.000Z");
    }));
});

describe("ingest extras — source fields the model doesn't declare land in _raw", () => {
  it("undeclared fields (nested, and named unlike SQL identifiers) are folded into _raw, not dropped and not fatal", () =>
    model.run(async () => {
      const src = orderAdapter("extras-land");
      src.set([{
        id: "ord-x", status: "NEW", amount: "900",
        region: "EMEA",
        "Deal Size (USD)": 1234,
        meta: { source: "crm", tags: ["a", "b"] },
      }]);
      const first = await ingestPull("extras-land", { derive: false });
      expect(first.inserted).toBe(1);
      const row = await store.findById("Order", "ord-x");
      expect(row!.status).toBe("NEW");
      const rawObj = JSON.parse(String(row!._raw));
      expect(rawObj).toEqual({ region: "EMEA", "Deal Size (USD)": 1234, meta: { source: "crm", tags: ["a", "b"] } });

      // Extras are never business evidence: the derived create event's payload
      // must not carry _raw or any undeclared field.
      await deriveFromData();
      const ev = await prisma.eventLog.findFirst({
        where: { workflowId: model.workflowId, aggregateId: "ord-x", eventRef: { contains: "OrderCreated" } },
      });
      const payload = JSON.parse(ev!.payload);
      expect(payload._raw).toBeUndefined();
      expect(payload.region).toBeUndefined();
    }));

  it("re-pulls MERGE extras per-key (a pull returning fewer extras never erases witnessed ones) and identical extras don't churn", () =>
    model.run(async () => {
      const src = orderAdapter("extras-merge");
      src.set([{ id: "ord-y", status: "NEW", region: "EMEA", owner: "kim" }]);
      await ingestPull("extras-merge", { derive: false });

      // Changed extra + new extra + omitted extra: only declared no-clobber
      // semantics, applied inside the fold — owner survives the omission.
      src.set([{ id: "ord-y", status: "NEW", region: "APAC", tier: "gold" }]);
      const second = await ingestPull("extras-merge", { derive: false });
      expect(second.updated).toBe(1); // extras-only drift still counts as drift
      const merged = JSON.parse(String((await store.findById("Order", "ord-y"))!._raw));
      expect(merged).toEqual({ region: "APAC", owner: "kim", tier: "gold" });

      // An identical re-pull converges to "unchanged" — the merged JSON is
      // byte-stable, so _raw must not churn the updated counter every pull.
      src.set([{ id: "ord-y", status: "NEW", region: "APAC", tier: "gold" }]);
      const third = await ingestPull("extras-merge", { derive: false });
      expect(third.updated).toBe(0);
      expect(third.skipped).toBe(1);
    }));

  it("rows with ONLY declared fields leave _raw untouched (null)", () =>
    model.run(async () => {
      const src = orderAdapter("extras-none");
      src.set([{ id: "ord-z", status: "NEW", amount: "10" }]);
      await ingestPull("extras-none", { derive: false });
      expect((await store.findById("Order", "ord-z"))!._raw).toBeNull();
    }));

  it("only witnessed VALUES enter the fold — null/empty extras are noise, and stored empties purge on merge", () =>
    model.run(async () => {
      const src = orderAdapter("extras-nulls");
      // HubSpot-style response: every property present, most of them null.
      src.set([{ id: "ord-h", status: "NEW", region: "EMEA", about_us: null, account_hypothesis: null, note: "" }]);
      await ingestPull("extras-nulls", { derive: false });
      let row = await store.findById("Order", "ord-h");
      expect(JSON.parse(String(row!._raw))).toEqual({ region: "EMEA" });

      // A fold written BEFORE the filter existed (null-laden) self-heals on the
      // next pull that merges: stored empties purge, real values survive.
      await store.update("Order", "ord-h", { _raw: '{"about_us":null,"region":"EMEA","legacy":"keep"}' }, Number(row!.version));
      src.set([{ id: "ord-h", status: "NEW", region: "APAC", about_us: null }]);
      const healed = await ingestPull("extras-nulls", { derive: false });
      expect(healed.updated).toBe(1);
      row = await store.findById("Order", "ord-h");
      expect(JSON.parse(String(row!._raw))).toEqual({ region: "APAC", legacy: "keep" });
    }));

  it("engine-owned platform column names from the source fold into _raw, never into live columns", () =>
    model.run(async () => {
      const src = orderAdapter("extras-engine");
      // 'version' would poison the optimistic lock (NaN expectedVersion bricks
      // every later upsert), 'organization_id' would defeat the tenant stamp,
      // and a truthy '_provisional' would trip the cycle wholesale merge. All
      // three are just DATA when the source happens to use those names.
      src.set([{ id: "ord-e", status: "NEW", version: "2.1.0", organization_id: "crm-org-9", _provisional: 1 }]);
      const first = await ingestPull("extras-engine", { derive: false });
      expect(first.inserted).toBe(1);
      const row = await store.findById("Order", "ord-e");
      expect(row).not.toBeNull(); // visible to the OWNING org — tenant stamp intact
      expect(row!.version).toBe(0); // the engine's lock seed, not the source string
      expect(row!._provisional).toBeNull();
      expect(JSON.parse(String(row!._raw))).toEqual({ version: "2.1.0", organization_id: "crm-org-9", _provisional: 1 });

      // Source drift still lands (the lock was not poisoned) and the provisional
      // wholesale-merge branch never fires.
      src.set([{ id: "ord-e", status: "SHIPPED", version: "2.1.0", organization_id: "crm-org-9", _provisional: 1 }]);
      const second = await ingestPull("extras-engine", { derive: false });
      expect(second.updated).toBe(1);
      expect(second.merged).toBe(0);
      expect((await store.findById("Order", "ord-e"))!.status).toBe("SHIPPED");
    }));

  it("a source field named __proto__ still lands in _raw (no prototype-accessor swallowing)", () =>
    model.run(async () => {
      const src = orderAdapter("extras-proto");
      // JSON.parse creates __proto__ as an OWN key — exactly how connector rows
      // arrive from the sandboxed child's result file.
      src.set([JSON.parse('{"id":"ord-p","status":"NEW","__proto__":{"polluted":true}}')]);
      await ingestPull("extras-proto", { derive: false });
      const raw = JSON.parse(String((await store.findById("Order", "ord-p"))!._raw));
      expect(raw["__proto__"]).toEqual({ polluted: true });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no global pollution either
    }));

  it("extras land even under an unchanged dateRoles.updated watermark (a rebuilt connector backfills _raw)", () =>
    model.run(async () => {
      const id = "extras-watermark";
      writeSidecar({
        id, kind: "simulated", boundedContext: "Shop", targetEntity: "Order",
        phase: "built", mode: "simulated", workflowId: model.workflowId,
        organizationId: model.orgId, dateRoles: { updated: "lastModified" },
      });
      sidecars.push(id);
      const src = orderAdapter(id);
      src.set([{ id: "ord-w", status: "NEW", lastModified: "2026-03-01T00:00:00.000Z" }]);
      await ingestPull(id, { derive: false });
      expect((await store.findById("Order", "ord-w"))!._raw).toBeNull();

      // The connector is rebuilt to capture-everything: same watermark, new
      // extras. The watermark still holds SOURCE drift (status must not land),
      // but the fold — platform bookkeeping — must.
      src.set([{ id: "ord-w", status: "SHIPPED", lastModified: "2026-03-01T00:00:00.000Z", region: "EMEA" }]);
      const second = await ingestPull(id, { derive: false });
      expect(second.updated).toBe(1);
      const row = await store.findById("Order", "ord-w");
      expect(row!.status).toBe("NEW");
      expect(JSON.parse(String(row!._raw))).toEqual({ region: "EMEA" });

      // An identical re-pull converges to skip — the merged JSON is byte-stable.
      const third = await ingestPull(id, { derive: false });
      expect(third.updated).toBe(0);
      expect(third.skipped).toBe(1);
    }));
});
