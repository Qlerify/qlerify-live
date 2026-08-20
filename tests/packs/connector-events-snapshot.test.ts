// The host half of ctx.readEvents: collectWorkflowEvents snapshots the ACTIVE
// workflow's EventLog for the sandboxed connector — tenant-scoped, oldest→newest
// with the NEWEST rows winning the cap, truncation flagged (never silent), dates
// as ISO strings, payloads JSON-parsed. The runner half (readEvents filters) is
// pinned in connector-sandbox.test.ts; this file pins the query + serialization.

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { collectWorkflowEvents } from "../../src/packs/adapters/connector.js";
import { SNAPSHOT_EVENT_ROWS } from "../../src/packs/connector/runtime.js";
import { modelHarness } from "../helpers/po-model.js";

const model = modelHarness();
const other = modelHarness(); // a different workflow — its rows must never leak in

const BASE = Date.UTC(2026, 0, 1);
const row = (owner: typeof model, i: number, payload: string) => ({
  eventName: `E${i}`,
  eventRef: `#/domainEvents/E${i}`,
  boundedContext: "SAP",
  aggregateRoot: "PurchaseOrder",
  aggregateId: `po-${i}`,
  caseId: `po-${i}`,
  role: "Buyer",
  payload,
  occurredAt: new Date(BASE + i * 1000),
  organizationId: owner.orgId,
  workflowId: owner.workflowId,
});

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { workflowId: { in: [model.workflowId, other.workflowId] } } });
});

describe("collectWorkflowEvents", () => {
  it("is tenant-scoped, oldest→newest, ISO dates, parsed payloads, non-JSON passthrough", async () => {
    await prisma.eventLog.createMany({
      data: [
        row(model, 1, JSON.stringify({ supplierId: "S1" })),
        row(model, 2, "not json"),
        row(other, 3, JSON.stringify({ leaked: true })),
      ],
    });
    const snap = await model.run(() => collectWorkflowEvents());
    expect(snap.truncated).toBe(false);
    expect(snap.rows.map((r) => r.eventName)).toEqual(["E1", "E2"]); // other workflow's E3 excluded
    expect(snap.rows[0]).toMatchObject({
      aggregateId: "po-1",
      caseId: "po-1",
      occurredAt: new Date(BASE + 1000).toISOString(),
      businessAt: null,
      payload: { supplierId: "S1" },
    });
    expect(snap.rows[1]!.payload).toBe("not json"); // unparseable stays a string
    // Tenancy/actor columns never cross the sandbox boundary.
    expect(snap.rows[0]).not.toHaveProperty("organizationId");
    expect(snap.rows[0]).not.toHaveProperty("workflowId");
    expect(snap.rows[0]).not.toHaveProperty("actorPrincipalId");
    await prisma.eventLog.deleteMany({ where: { workflowId: { in: [model.workflowId, other.workflowId] } } });
  });

  it("caps at SNAPSHOT_EVENT_ROWS keeping the NEWEST rows, and flags the clip", async () => {
    const n = SNAPSHOT_EVENT_ROWS + 1;
    await prisma.eventLog.createMany({
      data: Array.from({ length: n }, (_, i) => row(model, i, "{}")),
    });
    const snap = await model.run(() => collectWorkflowEvents());
    expect(snap.truncated).toBe(true);
    expect(snap.rows.length).toBe(SNAPSHOT_EVENT_ROWS);
    // The single OLDEST row (E0) is the one clipped; order stays oldest→newest.
    expect(snap.rows[0]!.eventName).toBe("E1");
    expect(snap.rows[snap.rows.length - 1]!.eventName).toBe(`E${n - 1}`);
    await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  });
});
