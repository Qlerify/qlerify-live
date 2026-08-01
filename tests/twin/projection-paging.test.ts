// Server-side paging + filtering in the projection store — the contract the
// explorer's pager rests on: findMany's offset windows are stable (createdAt,id
// order), RowFilters match the old client-side semantics (case-insensitive
// strings, numeric compare for Number type), and countRows under the same
// filters sizes the pager. 60 rows at explicit one-second createdAt steps make
// every window assertion deterministic.

import { describe, it, expect, beforeAll } from "vitest";
import { modelHarness } from "../helpers/po-model.js";
import { getOntology } from "../../src/ontology/model.js";
import * as store from "../../src/twin/projection-store.js";

const model = modelHarness();
const T = "PurchaseOrder";
const N = 60;

const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id);
const pid = (i: number) => `po-${String(i).padStart(2, "0")}`;

beforeAll(() =>
  model.run(async () => {
    await store.ensureTable(getOntology().entity(T)!);
    for (let i = 0; i < N; i++) {
      await store.insert(T, {
        id: pid(i),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        projectId: "p1",
        partNumber: `PN-${String(i).padStart(2, "0")}`,
        qty: i,
        supplierId: "sup-1",
        // Mixed case on purpose — filters must match case-insensitively.
        status: i % 2 ? "OPEN" : "closed",
      });
    }
  }));

describe("findMany offset windows", () => {
  it("returns the requested window in insertion order", () =>
    model.run(async () => {
      const rows = await store.findMany(T, 25, 25);
      expect(rows).toHaveLength(25);
      expect(rows[0].id).toBe(pid(25));
      expect(rows[24].id).toBe(pid(49));
    }));

  it("the last window is short, not padded or wrapped", () =>
    model.run(async () => {
      expect(ids(await store.findMany(T, 25, 50))).toEqual([...Array(10)].map((_, i) => pid(50 + i)));
      expect(await store.findMany(T, 25, N)).toEqual([]);
    }));

  it("limit null + offset reads everything after the offset", () =>
    model.run(async () => {
      const rows = await store.findMany(T, null, 30);
      expect(rows).toHaveLength(30);
      expect(rows[0].id).toBe(pid(30));
    }));
});

describe("RowFilters", () => {
  it("Equal to is case-insensitive for strings; countRows agrees with findMany", () =>
    model.run(async () => {
      const f = [{ attr: "status", cond: "Equal to", type: "String", value: "open" }];
      expect(await store.countRows(T, f)).toBe(30);
      expect(await store.findMany(T, null, 0, f)).toHaveLength(30);
    }));

  it("filters compose with offset windows", () =>
    model.run(async () => {
      const f = [{ attr: "status", cond: "Equal to", type: "String", value: "open" }];
      const rows = await store.findMany(T, 10, 10, f);
      // OPEN rows are the odd ids; the second window of 10 starts at the 11th (po-21).
      expect(ids(rows)).toEqual([...Array(10)].map((_, i) => pid(21 + 2 * i)));
    }));

  it("Number type compares numerically, not lexically", () =>
    model.run(async () => {
      expect(await store.countRows(T, [{ attr: "qty", cond: "Greater than", type: "Number", value: "49" }])).toBe(10);
      expect(await store.countRows(T, [{ attr: "qty", cond: "Less than", type: "Number", value: "5" }])).toBe(5);
    }));

  it("Contains and Begins with are case-insensitive substring ops", () =>
    model.run(async () => {
      expect(await store.countRows(T, [{ attr: "partNumber", cond: "Contains", type: "String", value: "n-0" }])).toBe(10);
      expect(await store.countRows(T, [{ attr: "partNumber", cond: "Begins with", type: "String", value: "pn-1" }])).toBe(10);
      expect(await store.countRows(T, [{ attr: "partNumber", cond: "Begins with", type: "String", value: "n-1" }])).toBe(0);
    }));

  it("Not equal to keeps the complement", () =>
    model.run(async () => {
      expect(await store.countRows(T, [{ attr: "status", cond: "Not equal to", type: "String", value: "OPEN" }])).toBe(30);
    }));

  it("multiple filters AND together", () =>
    model.run(async () => {
      const f = [
        { attr: "status", cond: "Equal to", type: "String", value: "open" },
        { attr: "qty", cond: "Less than", type: "Number", value: "10" },
      ];
      expect(await store.countRows(T, f)).toBe(5); // qty 1,3,5,7,9
    }));

  it("a filter on a column the table lacks is skipped, not an error", () =>
    model.run(async () => {
      expect(await store.countRows(T, [{ attr: "noSuchColumn", cond: "Equal to", type: "String", value: "x" }])).toBe(N);
    }));

  it("blank-value filters are inactive", () =>
    model.run(async () => {
      expect(await store.countRows(T, [{ attr: "status", cond: "Equal to", type: "String", value: "" }])).toBe(N);
    }));
});
