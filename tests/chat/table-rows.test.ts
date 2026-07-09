// list_table_rows — the read tool the simulate-content doctrine leans on: check
// whether an upstream table is populated before fabricating downstream rows, and
// fetch real ids for reference fields. Org/workflow scoping comes from the
// projection store; here we pin the tool's contract (shape, empty-table behavior,
// limit, and that the tenancy column never leaks).

import { describe, it, expect, beforeAll } from "vitest";
import { runTool } from "../../src/chat/tools.js";
import { modelHarness } from "../helpers/po-model.js";
import { getOntology } from "../../src/ontology/model.js";
import * as store from "../../src/twin/projection-store.js";

const model = modelHarness();

function parse(r: { content: string }): any {
  return JSON.parse(r.content);
}

beforeAll(() =>
  model.run(async () => {
    await store.ensureTable(getOntology().entity("PurchaseOrder")!);
    for (let i = 0; i < 3; i++) {
      await store.insert("PurchaseOrder", {
        id: `po-${i}`, projectId: "p1", partNumber: `PN-${i}`, qty: i + 1, supplierId: "sup-1", status: "DRAFT",
      });
    }
  }));

describe("list_table_rows", () => {
  it("returns count + rows for a populated table, without organization_id", () =>
    model.run(async () => {
      const r = parse(await runTool("list_table_rows", { table: "PurchaseOrder" }));
      expect(r.table).toBe("PurchaseOrder");
      expect(r.count).toBe(3);
      expect(r.rows).toHaveLength(3);
      expect(r.rows.map((x: any) => x.id).sort()).toEqual(["po-0", "po-1", "po-2"]);
      for (const row of r.rows) expect(row).not.toHaveProperty("organization_id");
    }));

  it("caps rows at `limit` while count stays the full total", () =>
    model.run(async () => {
      const r = parse(await runTool("list_table_rows", { table: "PurchaseOrder", limit: 2 }));
      expect(r.count).toBe(3);
      expect(r.rows).toHaveLength(2);
    }));

  it("a model table that was never ingested reads as empty, not an error", async () => {
    // Fresh harness = fresh gen__p namespace: the entity exists in the model but
    // no projection table has been created yet.
    const fresh = modelHarness();
    const r = parse(await fresh.run(() => runTool("list_table_rows", { table: "PurchaseOrder" })));
    expect(r.count).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it("rejects a name that is not in the model", () =>
    model.run(async () => {
      const r = parse(await runTool("list_table_rows", { table: "NotATable" }));
      expect(r.error).toMatch(/no entity or value object/);
    }));
});
