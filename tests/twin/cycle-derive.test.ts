// Period-scoped cycles end-to-end, WITHOUT any real connector: rows land in the
// store the way a pull would leave them, and the framework must (a) correlate
// each child into the cycle case its subject key + business date name, matching
// on COLUMN VALUES so legacy row ids still resolve, (b) lazily open a missing
// period's cycle row — provisional, canonical id, create event at period start —
// (c) report unknown subject values instead of fabricating cycles for them, and
// (d) at ingest, compose the canonical cycle id itself and MERGE a pull into a
// provisional row instead of skipping on the existing id.

import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { getOntology } from "../../src/ontology/model.js";
import { deriveFromData } from "../../src/twin/derive.js";
import { periodOf } from "../../src/twin/period.js";
import { ingestPull } from "../../src/packs/ingest.js";
import { registerAdapter } from "../../src/packs/registry.js";
import * as store from "../../src/twin/projection-store.js";
import { modelHarness } from "../helpers/po-model.js";

// The "Quarterly Cycle Dashboard" shape: Quarter is one Company × one quarter,
// declared period-scoped by its composite key; Meeting carries only the subject
// FK (companyId) and its own date. No entity named Company exists — the rename
// that broke the *Id heuristic — so ONLY cycle correlation can connect these.
const CYCLE_MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Hubspot",
  roles: ["Sales"],
  domainEvents: {
    CycleStarted: {
      event: "Cycle Started",
      role: "Sales",
      command: { $ref: "#/schemas/commands/StartCycle" },
      aggregateRoot: { $ref: "#/schemas/entities/Quarter" },
    },
    MeetingHeld: {
      event: "Meeting Held",
      role: "Sales",
      follows: [{ $ref: "#/domainEvents/CycleStarted" }],
      command: { $ref: "#/schemas/commands/RecordMeeting" },
      aggregateRoot: { $ref: "#/schemas/entities/Meeting" },
    },
  },
  schemas: {
    entities: {
      Quarter: {
        required: ["id"],
        key: ["hubspotCompanyId", "quarter"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "quarter", dataType: "string" },
          { name: "hubspotCompanyId", dataType: "string" },
          { name: "name", dataType: "string" },
        ],
      },
      Meeting: {
        required: ["id"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "companyId", dataType: "string" },
          { name: "scheduledAt", dataType: "datetime" },
        ],
      },
    },
    commands: {
      StartCycle: { required: [], fields: [{ name: "quarter" }] },
      RecordMeeting: { required: ["companyId"], fields: [{ name: "companyId" }, { name: "scheduledAt" }] },
    },
  },
});

const model = modelHarness(CYCLE_MODEL);

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { workflowId: model.workflowId } });
  await store.dropProjectionTablesForWorkflow(model.workflowId);
});

describe("cycle derivation — subject × period correlation, lazy opening, diagnostics", () => {
  it("correlates per quarter, opens a missing period provisionally, reports unknown subjects, stays idempotent", () =>
    model.run(async () => {
      const ont = getOntology();
      await store.ensureTable(ont.entity("Quarter")!);
      await store.ensureTable(ont.entity("Meeting")!);
      // A LEGACY-shaped cycle row id (no @suffix): resolution is by column
      // values, so it must still anchor its quarter's case.
      await store.insert("Quarter", { id: "hubspot-company-1", hubspotCompanyId: "hubspot-company-1", quarter: "2026Q3", name: "Acme" });
      await store.insert("Meeting", { id: "m-q3", companyId: "hubspot-company-1", scheduledAt: "2026-08-14T10:00:00.000Z" });
      await store.insert("Meeting", { id: "m-q4", companyId: "hubspot-company-1", scheduledAt: "2026-10-05T09:00:00.000Z" });
      await store.insert("Meeting", { id: "m-orphan", companyId: "acme-inc", scheduledAt: "2026-08-20T09:00:00.000Z" });

      const r = await deriveFromData();
      expect(r.cycles).toEqual({
        opened: 1,
        noBusinessDate: 0,
        unknownSubjects: [{ target: "Quarter", value: "acme-inc", events: 1 }],
      });

      // The Q3 meeting joined the EXISTING (legacy-id) Quarter's case.
      const q3 = await prisma.eventLog.findFirst({ where: { workflowId: model.workflowId, aggregateId: "m-q3" } });
      expect(q3!.caseId).toBe("hubspot-company-1");

      // The Q4 meeting had no cycle row — the engine opened one: canonical id,
      // provisional, template fields copied, honest start-of-period create.
      const q4 = await prisma.eventLog.findFirst({ where: { workflowId: model.workflowId, aggregateId: "m-q4" } });
      expect(q4!.caseId).toBe("hubspot-company-1@2026Q4");
      const opened = await store.findById("Quarter", "hubspot-company-1@2026Q4");
      expect(opened).not.toBeNull();
      expect(opened!._provisional).toBe(1);
      expect(opened!.quarter).toBe("2026Q4");
      expect(opened!.name).toBe("Acme");
      const started = await prisma.eventLog.findFirst({
        where: { workflowId: model.workflowId, aggregateId: "hubspot-company-1@2026Q4" },
      });
      expect(started!.caseId).toBe("hubspot-company-1@2026Q4");
      expect(started!.businessAt!.toISOString()).toBe("2026-10-01T00:00:00.000Z");
      expect(started!.businessAtKind).toBe("estimated");

      // The unknown subject anchored its own case and fabricated NO cycle row.
      const orphan = await prisma.eventLog.findFirst({ where: { workflowId: model.workflowId, aggregateId: "m-orphan" } });
      expect(orphan!.caseId).toBe("m-orphan");
      expect((await store.findMany("Quarter", null)).map((row) => row.id).sort()).toEqual([
        "hubspot-company-1",
        "hubspot-company-1@2026Q4",
      ]);

      // Idempotent: the second pass emits nothing and re-opens nothing.
      const again = await deriveFromData();
      expect(again.totalEmitted).toBe(0);
      expect(again.cycles!.opened).toBe(0);
    }));
});

describe("cycle ingest — engine-composed canonical ids and provisional merge", () => {
  function quarterAdapter(id: string, rows: Array<Record<string, unknown>>) {
    return {
      id,
      kind: "simulated",
      boundedContext: "Hubspot",
      targetEntity: "Quarter",
      mode: "simulated" as const,
      async introspect() { return { entity: "Quarter", fields: [] }; },
      async mapping() { return {}; },
      async pull() { return { rows: { Quarter: rows }, count: rows.length }; },
      async push() { return { pushed: 0 }; },
      async healthcheck() { return { ok: true }; },
    };
  }

  it("replaces a connector-supplied id with the canonical subject@period id, and warns", () =>
    model.run(async () => {
      registerAdapter(quarterAdapter("test-cycle-compose", [
        { id: "hubspot-company-2", hubspotCompanyId: "hubspot-company-2", quarter: "2026Q3", name: "Beta" },
      ]));
      const summary = await ingestPull("test-cycle-compose", { derive: false });
      expect(summary.inserted).toBe(1);
      expect(summary.warnings?.some((w) => w.includes("canonical cycle id"))).toBe(true);
      expect(await store.findById("Quarter", "hubspot-company-2@2026Q3")).not.toBeNull();
      expect(await store.findById("Quarter", "hubspot-company-2")).toBeNull();
    }));

  it("defaults a missing period to the current one (a pull is a snapshot OF a period)", () =>
    model.run(async () => {
      registerAdapter(quarterAdapter("test-cycle-default", [
        { hubspotCompanyId: "hubspot-company-3", name: "Gamma" },
      ]));
      const summary = await ingestPull("test-cycle-default", { derive: false });
      expect(summary.inserted).toBe(1);
      const current = periodOf(new Date(), "quarter");
      const row = await store.findById("Quarter", `hubspot-company-3@${current}`);
      expect(row!.quarter).toBe(current);
      expect(summary.warnings?.some((w) => w.includes("defaulted to the current period"))).toBe(true);
    }));

  it("merges a pull into the provisional row the engine opened, clearing the placeholder mark", () =>
    model.run(async () => {
      // The provisional hubspot-company-1@2026Q4 row from the derive test above.
      registerAdapter(quarterAdapter("test-cycle-merge", [
        { hubspotCompanyId: "hubspot-company-1", quarter: "2026Q4", name: "Acme (renamed)" },
      ]));
      const summary = await ingestPull("test-cycle-merge", { derive: false });
      expect(summary.inserted).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.merged).toBe(1);
      const row = await store.findById("Quarter", "hubspot-company-1@2026Q4");
      expect(row!._provisional).toBeNull();
      expect(row!.name).toBe("Acme (renamed)");
      // A SECOND identical pull now skips normally — the row is no longer provisional.
      const again = await ingestPull("test-cycle-merge", { derive: false });
      expect(again.merged).toBe(0);
      expect(again.skipped).toBe(1);
    }));
});
