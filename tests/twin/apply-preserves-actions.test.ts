// A projection table is normally disposable: re-run the connector and it comes
// back. That is false for an actuator, whose rows record actions it performed in
// another system — and reingestAll deliberately refuses to re-run it, so nothing
// puts them back. Reproduced live: a Slack connector announced the same user a
// second time because a model re-import deleted the row saying it already had.

import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import * as store from "../../src/twin/projection-store.js";
import { getOntology, loadOntologyFromStrings } from "../../src/ontology/model.js";
import { modelHarness, PURCHASE_ORDER_MODEL } from "../helpers/po-model.js";

const model = modelHarness();
const PO_TABLE = `gen__p${model.workflowId.replace(/-/g, "")}_PurchaseOrder`;

// PurchaseOrder gains `note` and loses `partNumber`, so the carry-across has to
// intersect with the new shape rather than assume it is unchanged.
const RESHAPED = (() => {
  const m = JSON.parse(PURCHASE_ORDER_MODEL);
  const po = m.schemas.entities.PurchaseOrder;
  po.fields = po.fields.filter((f: { name: string }) => f.name !== "partNumber");
  po.fields.push({ name: "note", dataType: "string" });
  po.required = po.required.filter((r: string) => r !== "partNumber");
  return JSON.stringify(m);
})();

// A model carrying a VALUE OBJECT. Connectors can target these, and their tables
// are normally created lazily rather than by applyModelTables — a preserved one
// still has to be rebuilt and intersected like an entity. `gained` adds a column
// so the intersect is exercised too.
const withVo = (gained: boolean) => {
  const m = JSON.parse(PURCHASE_ORDER_MODEL);
  const fields: Array<Record<string, unknown>> = [
    { name: "id", dataType: "string" },
    { name: "carrier", dataType: "string" },
  ];
  if (gained) fields.push({ name: "note", dataType: "string" });
  m.schemas.valueObjects = { Shipment: { required: ["id"], fields } };
  m.schemas.entities.PurchaseOrder.fields.push({
    name: "shipment", relatedEntity: { $ref: "#/schemas/valueObjects/Shipment" },
  });
  return JSON.stringify(m);
};

// A model with no PurchaseOrder at all — the entity-was-removed case.
const WITHOUT_PO = JSON.stringify({
  version: 1,
  boundedContext: "SAP",
  roles: ["Buyer"],
  domainEvents: {
    ThingHappened: {
      event: "Thing Happened",
      role: "Buyer",
      command: { $ref: "#/schemas/commands/DoThing" },
      aggregateRoot: { $ref: "#/schemas/entities/Thing" },
    },
  },
  schemas: {
    entities: { Thing: { required: ["id"], fields: [{ name: "id", dataType: "string" }] } },
    commands: { DoThing: { required: ["id"], fields: [{ name: "id" }] } },
  },
});

const seed = async (n: number) => {
  await store.ensureTable(getOntology().entity("PurchaseOrder")!);
  for (let i = 0; i < n; i++) {
    await store.insert("PurchaseOrder", {
      id: `po-${i}`, projectId: "p1", partNumber: "X", qty: 1, supplierId: "s1", status: "DRAFT",
    });
  }
};

afterEach(() => model.run(() => store.dropProjectionTablesForWorkflow(model.workflowId)));

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  await store.dropProjectionTablesForWorkflow(model.workflowId);
});

describe("applyModelTables — preserving what a connector already did", () => {
  it("wipes a table by default, because re-running the connector rebuilds it", () =>
    model.run(async () => {
      await seed(3);
      const r = await store.applyModelTables(getOntology());
      expect(r.dropped).toContain("PurchaseOrder");
      expect(await store.countRows("PurchaseOrder")).toBe(0);
      expect(r.preserved).toEqual({});
    }));

  it("carries a preserved table's rows across the drop and recreate", () =>
    model.run(async () => {
      await seed(3);
      const r = await store.applyModelTables(getOntology(), { preserve: ["PurchaseOrder"] });
      expect(r.preserved).toEqual({ PurchaseOrder: 3 });
      expect(await store.countRows("PurchaseOrder")).toBe(3);
      const back = await store.findById("PurchaseOrder", "po-1");
      expect(back).toMatchObject({ id: "po-1", supplierId: "s1", status: "DRAFT" });
    }));

  it("keeps the rows' own timestamps and versions rather than restamping them", () =>
    model.run(async () => {
      await seed(1);
      const before = (await store.findById("PurchaseOrder", "po-0"))!;
      await store.update("PurchaseOrder", "po-0", { status: "SHIPPED" }, 0);
      const bumped = (await store.findById("PurchaseOrder", "po-0"))!;
      expect(bumped.version).toBe(1);

      await store.applyModelTables(getOntology(), { preserve: ["PurchaseOrder"] });
      const after = (await store.findById("PurchaseOrder", "po-0"))!;
      expect(after.version).toBe(1); // not reset to 0
      expect(after.createdAt).toBe(before.createdAt); // not stamped with "now"
      expect(after.status).toBe("SHIPPED");
    }));

  it("intersects with the new model's columns when the entity's shape changed", () =>
    model.run(async () => {
      await seed(2);
      const reshaped = loadOntologyFromStrings(RESHAPED, null);
      const r = await store.applyModelTables(reshaped, { preserve: ["PurchaseOrder"] });
      expect(r.preserved).toEqual({ PurchaseOrder: 2 });
      const row = (await store.findById("PurchaseOrder", "po-0"))!;
      expect(row.supplierId).toBe("s1"); // a column the new model still declares
      expect(row.note).toBeNull(); // a column it gained, empty rather than absent
      expect(row).not.toHaveProperty("partNumber"); // a column it lost, dropped with it
    }));

  it("leaves the table STANDING when its entity left the model, instead of dropping it", () =>
    model.run(async () => {
      await seed(2);
      const without = loadOntologyFromStrings(WITHOUT_PO, null);
      const r = await store.applyModelTables(without, { preserve: ["PurchaseOrder"] });
      expect(r.orphaned).toEqual(["PurchaseOrder"]);
      expect(r.dropped).not.toContain("PurchaseOrder");
      // The one kind of data nothing can rebuild is still there to recover.
      expect(await store.countRows("PurchaseOrder")).toBe(2);
    }));

  it("still drops an UNpreserved table whose entity left the model", () =>
    model.run(async () => {
      await seed(2);
      const without = loadOntologyFromStrings(WITHOUT_PO, null);
      const r = await store.applyModelTables(without);
      expect(r.orphaned).toEqual([]);
      expect(r.dropped).toContain("PurchaseOrder");
    }));

  it("handles a preserved table that has no rows yet", () =>
    model.run(async () => {
      await store.ensureTable(getOntology().entity("PurchaseOrder")!);
      const r = await store.applyModelTables(getOntology(), { preserve: ["PurchaseOrder"] });
      expect(r.preserved).toEqual({});
      expect(await store.countRows("PurchaseOrder")).toBe(0);
    }));

  // findMany filters by organization_id, so reading the rows through it would
  // leave behind anything inserted without one — silently dropping a subset of
  // the very data this exists to keep.
  it("carries rows that carry no organization, instead of leaving them to be dropped", () =>
    model.run(async () => {
      await seed(2);
      await prisma.$executeRawUnsafe(`UPDATE ${PO_TABLE} SET organization_id = NULL WHERE id = 'po-0'`);
      const r = await store.applyModelTables(getOntology(), { preserve: ["PurchaseOrder"] });
      expect(r.preserved).toEqual({ PurchaseOrder: 2 });
      // countRows is org-filtered too, so ask the table directly: the row with
      // no owner has to be back, not merely uncounted.
      const raw = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*) AS n FROM ${PO_TABLE}`);
      expect(Number(raw[0]!.n)).toBe(2);
    }));

  it("rebuilds and carries a preserved VALUE OBJECT, not just an entity", () =>
    model.run(async () => {
      const before = loadOntologyFromStrings(withVo(false), null);
      await store.ensureTable(before.valueObject("Shipment")!);
      await store.insert("Shipment", { id: "shp-1", carrier: "DHL" });

      const after = loadOntologyFromStrings(withVo(true), null);
      const r = await store.applyModelTables(after, { preserve: ["Shipment"] });

      // Rebuilt like an entity rather than abandoned as "orphaned".
      expect(r.orphaned).toEqual([]);
      expect(r.created).toContain("Shipment");
      expect(r.preserved).toEqual({ Shipment: 1 });
      const row = (await store.findById("Shipment", "shp-1"))!;
      expect(row.carrier).toBe("DHL"); // the row survived
      expect(Object.keys(row)).toContain("note"); // and the shape followed the model
    }));

  it("leaves an UNpreserved value object to be created lazily, as before", () =>
    model.run(async () => {
      const ont = loadOntologyFromStrings(withVo(false), null);
      await store.ensureTable(ont.valueObject("Shipment")!);
      const r = await store.applyModelTables(ont);
      expect(r.created).not.toContain("Shipment");
      expect(await store.tableExists("Shipment")).toBe(false);
    }));

  it("carries a batch bigger than SQLite's parameter ceiling", () =>
    model.run(async () => {
      await seed(250); // 250 rows x ~11 columns is well past 999 host parameters
      const r = await store.applyModelTables(getOntology(), { preserve: ["PurchaseOrder"] });
      expect(r.preserved).toEqual({ PurchaseOrder: 250 });
      expect(await store.countRows("PurchaseOrder")).toBe(250);
    }));
});

// Independent of preservation, and the reason applyModelTables drops the DB
// connection: Prisma caches a raw query's COLUMN NAMES against its SQL text. A
// table recreated with a different shape therefore keeps answering `SELECT *`
// with the OLD names in front of the NEW values — every read of a reshaped
// entity is silently mislabelled until something clears it. Nothing errors.
describe("a rebuilt table reads back under its own column names", () => {
  it("does not serve the previous shape's names after a reshape", () =>
    model.run(async () => {
      await seed(1);
      // Warm the cache for this table's SELECT text under the OLD shape.
      expect((await store.findById("PurchaseOrder", "po-0"))!.partNumber).toBe("X");

      await store.applyModelTables(loadOntologyFromStrings(RESHAPED, null), { preserve: ["PurchaseOrder"] });

      const row = (await store.findById("PurchaseOrder", "po-0"))!;
      expect(Object.keys(row)).toContain("note"); // the new column, by name
      expect(Object.keys(row)).not.toContain("partNumber"); // the dropped one, gone
      expect(row.status).toBe("DRAFT"); // and every value under its own key
      expect(row.supplierId).toBe("s1");
      expect(row.qty).toBe(1);
    }));
});
