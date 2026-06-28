// The deterministic date-role heuristic: from a target schema's fields, which
// column is the source's creation timestamp and which is its last-modified one.
// Pure (no DB / disk / network) — the AI refinement on top is exercised only when
// these leave a gap.

import { describe, it, expect } from "vitest";
import { inferDateRoles, timestampFields } from "../../src/packs/connector/codegen.js";
import type { EntitySchema } from "../../src/ontology/model.js";

function entity(fields: Array<{ name: string; dataType?: string }>): EntitySchema {
  return { name: "Order", required: [], fields } as unknown as EntitySchema;
}

describe("timestampFields", () => {
  it("keeps plausibly-temporal business columns, then the platform timestamps", () => {
    const tf = timestampFields(entity([
      { name: "id", dataType: "string" },
      { name: "amount", dataType: "number" },
      { name: "creator", dataType: "string" }, // a name, NOT a timestamp
      { name: "created_at", dataType: "string" },
      { name: "placedOn", dataType: "date" },
    ]));
    // business date fields first (creator excluded), platform cols appended.
    expect(tf).toEqual(["created_at", "placedOn", "createdAt", "updatedAt"]);
  });

  it("always surfaces the platform createdAt/updatedAt — even with no business date field", () => {
    // The Account case: email/status/… but no declared date column.
    const tf = timestampFields(entity([{ name: "email" }, { name: "status" }]));
    expect(tf).toEqual(["createdAt", "updatedAt"]);
  });

  it("does not duplicate a declared createdAt/updatedAt", () => {
    const tf = timestampFields(entity([{ name: "createdAt", dataType: "date" }]));
    expect(tf).toEqual(["createdAt", "updatedAt"]);
  });
});

describe("inferDateRoles", () => {
  it("maps snake_case created_at / updated_at", () => {
    const r = inferDateRoles(entity([
      { name: "created_at", dataType: "string" },
      { name: "updated_at", dataType: "string" },
    ]));
    expect(r.created).toBe("created_at");
    expect(r.updated).toBe("updated_at");
  });

  it("prefers a business date field over the platform column", () => {
    // registeredAt should win `created` over the platform createdAt.
    const r = inferDateRoles(entity([{ name: "registeredAt", dataType: "date" }]));
    expect(r.created).toBe("registeredAt");
  });

  it("falls back to the platform createdAt/updatedAt when there is no business date field", () => {
    const r = inferDateRoles(entity([{ name: "email" }, { name: "status" }]));
    expect(r).toEqual({ created: "createdAt", updated: "updatedAt" });
  });

  it("recognises domain-flavoured creation names (placedAt)", () => {
    expect(inferDateRoles(entity([{ name: "placedAt", dataType: "date" }])).created).toBe("placedAt");
  });

  it("does not mistake a non-temporal 'creator' column for a business timestamp", () => {
    // 'creator' is excluded; only the platform cols remain as candidates.
    expect(timestampFields(entity([{ name: "creator", dataType: "string" }]))).toEqual(["createdAt", "updatedAt"]);
  });
});
