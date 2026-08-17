// The chat's scheduling tool. Before this existed, asking the assistant to poll a
// source did nothing at all: there was no tool to call and no way to read the
// schedule back, so a "poll every 6 hours" request was silently dropped.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runTool, TOOLS } from "../../src/chat/tools.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { newId } from "../../src/platform/ids.js";
import { prisma } from "../../src/db.js";
import { readSidecar, writeSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import { deleteConnectorFiles } from "../../src/packs/connector/runtime.js";
import { SCHEDULE_MIN_MINUTES, ScheduleError, setConnectorSchedule } from "../../src/packs/scheduler.js";
import { readDoc } from "../../src/packs/connector/journal.js";
import type { TenantContext } from "../../src/platform/types.js";

const SFX = `sch${Date.now().toString(36)}`;
const ID = `chat-sched-${SFX}`;
const ID_FOREIGN = `chat-sched-foreign-${SFX}`;

const adminOrg = newId();
const wfId = newId();
const adminCtx: TenantContext = {
  organizationId: adminOrg,
  principal: { id: newId(), type: "identity" },
  workflowId: wfId,
  actingAsPlatformAdmin: true,
};
const asAdmin = <T>(fn: () => Promise<T> | T): Promise<T> => runWithTenant(adminCtx, async () => fn());

const parse = (r: { content: string }) => JSON.parse(r.content);

beforeAll(() => {
  writeSidecar({ id: ID, kind: "connector", boundedContext: "TestBC", targetEntity: "TestEntity", phase: "built", mode: "live", workflowId: wfId, organizationId: adminOrg });
  writeSidecar({ id: ID_FOREIGN, kind: "connector", boundedContext: "TestBC", targetEntity: "Other", phase: "built", mode: "live", workflowId: newId(), organizationId: adminOrg });
});

afterAll(async () => {
  for (const id of [ID, ID_FOREIGN]) { deleteSidecar(id); deleteConnectorFiles(id); }
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: adminOrg } });
});

describe("set_connector_schedule", () => {
  it("is offered to the model with the arguments it needs", () => {
    const tool = TOOLS.find((t) => t.name === "set_connector_schedule");
    expect(tool).toBeTruthy();
    expect(Object.keys(tool!.input_schema.properties ?? {}).sort()).toEqual(
      ["adapterId", "confirmed", "enabled", "everyMinutes"],
    );
    expect(tool!.input_schema.required).toContain("confirmed");
  });

  it("refuses to enable polling without confirmation", async () => {
    const r = await asAdmin(() => runTool("set_connector_schedule", { adapterId: ID, enabled: true, everyMinutes: 360, confirmed: false }));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/confirmed=false/);
    expect(readSidecar(ID)?.schedule).toBeUndefined(); // nothing written
  });

  it("turns polling on at the requested interval", async () => {
    const r = await asAdmin(() => runTool("set_connector_schedule", { adapterId: ID, enabled: true, everyMinutes: 360, confirmed: true }));
    expect(r.isError).toBe(false);
    const out = parse(r);
    expect(out.schedule).toMatchObject({ enabled: true, everyMinutes: 360 });
    expect(out.nextRunAt).toBeTruthy();
    expect(readSidecar(ID)?.schedule).toMatchObject({ enabled: true, everyMinutes: 360 });
  });

  it("reports the schedule back through get_adapter_config", async () => {
    const cfg = parse(await asAdmin(() => runTool("get_adapter_config", { adapterId: ID })));
    expect(cfg.schedule).toMatchObject({ enabled: true, everyMinutes: 360 });
    expect(cfg.nextRunAt).toBeTruthy();
    expect(cfg).not.toHaveProperty("secret");
  });

  it("changes the interval of an already-polling connector", async () => {
    const out = parse(await asAdmin(() => runTool("set_connector_schedule", { adapterId: ID, enabled: true, everyMinutes: 720, confirmed: true })));
    expect(out.schedule).toMatchObject({ enabled: true, everyMinutes: 720 });
    expect(readSidecar(ID)?.schedule?.everyMinutes).toBe(720);
    expect((readDoc(ID)?.notes ?? []).some((n: any) => /interval changed to every 720 min/.test(n.text))).toBe(true);
    await asAdmin(() => runTool("set_connector_schedule", { adapterId: ID, enabled: true, everyMinutes: 360, confirmed: true }));
  });

  // The scheduler auto-disables a connector after repeated failures; setting a
  // schedule is also how an operator (or the assistant) revives it.
  it("clears a failure streak and the auto-disable reason", async () => {
    const cur = readSidecar(ID)!;
    writeSidecar({ ...cur, schedule: { enabled: false, everyMinutes: 360, failures: 5, disabledReason: "auto-disabled after 5 consecutive failures: boom" } });
    const out = parse(await asAdmin(() => runTool("set_connector_schedule", { adapterId: ID, enabled: true, everyMinutes: 360, confirmed: true })));
    expect(out.schedule.failures).toBe(0);
    expect(readSidecar(ID)?.schedule?.disabledReason).toBeUndefined();
  });

  it("rejects an interval below the floor instead of silently accepting it", async () => {
    const r = await asAdmin(() => runTool("set_connector_schedule", { adapterId: ID, enabled: true, everyMinutes: SCHEDULE_MIN_MINUTES - 1, confirmed: true }));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(new RegExp(String(SCHEDULE_MIN_MINUTES)));
    expect(readSidecar(ID)?.schedule?.everyMinutes).toBe(360); // unchanged
  });

  it("keeps the chosen interval when polling is turned off", async () => {
    const out = parse(await asAdmin(() => runTool("set_connector_schedule", { adapterId: ID, enabled: false, confirmed: true })));
    expect(out.schedule).toMatchObject({ enabled: false, everyMinutes: 360 });
    expect(out.nextRunAt).toBeNull();
  });

  it("journals the change so it shows in the connector's history", () => {
    const notes = readDoc(ID)?.notes ?? [];
    expect(notes.some((n: any) => /Polling enabled — every 360 min/.test(n.text))).toBe(true);
    expect(notes.some((n: any) => /Polling disabled/.test(n.text))).toBe(true);
  });

  // A missing connector and a bad interval are different failures: the HTTP route
  // maps them to 404 and 400, so they must stay distinguishable at the source.
  it("distinguishes an unknown connector from an invalid interval", () => {
    let unknown: unknown;
    try {
      setConnectorSchedule(`no-such-${SFX}`, { enabled: true, everyMinutes: 60 });
    } catch (e) {
      unknown = e;
    }
    expect(unknown).toBeInstanceOf(ScheduleError);
    expect((unknown as ScheduleError).code).toBe("UNKNOWN_CONNECTOR");

    let bad: unknown;
    try {
      setConnectorSchedule(ID, { enabled: true, everyMinutes: 1 });
    } catch (e) {
      bad = e;
    }
    expect((bad as ScheduleError).code).toBe("BAD_INTERVAL");
  });

  it("cannot schedule another workflow's connector", async () => {
    const r = await asAdmin(() => runTool("set_connector_schedule", { adapterId: ID_FOREIGN, enabled: true, everyMinutes: 60, confirmed: true }));
    expect(r.isError).toBe(true);
    expect(readSidecar(ID_FOREIGN)?.schedule).toBeUndefined();
  });

  it("is denied outright without an authorized context", async () => {
    const r = await runTool("set_connector_schedule", { adapterId: ID, enabled: true, everyMinutes: 60, confirmed: true });
    expect(r.isError).toBe(true);
  });
});
