import { describe, it, expect, afterAll } from "vitest";
import { isDue, nextRunAt, setConnectorSchedule, ScheduleError } from "../../src/packs/scheduler.js";
import { writeSidecar, readSidecar, deleteSidecar } from "../../src/packs/sidecar.js";
import type { AdapterConfig } from "../../src/packs/types.js";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const at = (iso: string) => Date.parse(iso);
const minutes = (m: number) => m * 60_000;

const sched = (s: Partial<NonNullable<AdapterConfig["schedule"]>>): AdapterConfig =>
  ({
    id: "sap-purchaseorder", kind: "connector", boundedContext: "SAP", targetEntity: "PurchaseOrder",
    phase: "built", mode: "live", organizationId: "org-1", workflowId: "wf-1",
    schedule: { enabled: true, everyMinutes: 360, ...s },
  }) as AdapterConfig;

describe("a first run time holds the run back until it arrives", () => {
  it("does not fire before the start, however long the connector has been idle", () => {
    const c = sched({ startAt: "2026-08-21T14:00:00.000Z", lastAttemptAt: "2026-08-01T00:00:00.000Z" });
    expect(isDue(c, NOW)).toBe(false);
    expect(nextRunAt(c, NOW)).toBe("2026-08-21T14:00:00.000Z");
  });

  it("fires once the start arrives, for a connector that never ran", () => {
    const c = sched({ startAt: "2026-08-21T12:00:00.000Z" });
    expect(isDue(c, NOW)).toBe(true);
  });

  it("catches up rather than skipping when the start is already past", () => {
    const c = sched({ startAt: "2026-08-21T11:00:00.000Z" });
    expect(isDue(c, NOW)).toBe(true);
    expect(nextRunAt(c, NOW)).toBe("2026-08-21T11:00:00.000Z");
  });
});

describe("later runs sit on a grid, so a late run never shifts the ones after it", () => {
  const startAt = "2026-08-21T12:00:00.000Z";

  it("puts the next run one interval after the START, not after a late attempt", () => {
    // Due at 12:00, actually ran at 12:00:47 — the 18:00 slot must not become 18:00:47.
    const c = sched({ startAt, lastAttemptAt: "2026-08-21T12:00:47.000Z" });
    expect(nextRunAt(c, at("2026-08-21T12:01:00.000Z"))).toBe("2026-08-21T18:00:00.000Z");
  });

  it("does not accumulate lateness across many cycles", () => {
    // Every run has fired a little late all week; the grid is still exact.
    const c = sched({ startAt, lastAttemptAt: "2026-08-25T00:03:20.000Z" });
    expect(nextRunAt(c, at("2026-08-25T00:04:00.000Z"))).toBe("2026-08-25T06:00:00.000Z");
  });

  it("keeps two staggered connectors exactly ten minutes apart after a week", () => {
    const a = sched({ startAt: "2026-08-21T12:00:00.000Z", lastAttemptAt: "2026-08-28T00:00:31.000Z" });
    const b = sched({ startAt: "2026-08-21T12:10:00.000Z", lastAttemptAt: "2026-08-28T00:10:52.000Z" });
    const later = at("2026-08-28T00:11:00.000Z");
    const gap = Date.parse(nextRunAt(b, later)!) - Date.parse(nextRunAt(a, later)!);
    expect(gap).toBe(minutes(10));
  });

  it("is due again as soon as the next slot passes, and not before", () => {
    const c = sched({ startAt, lastAttemptAt: "2026-08-21T12:00:10.000Z" });
    expect(isDue(c, at("2026-08-21T17:59:00.000Z"))).toBe(false);
    expect(isDue(c, at("2026-08-21T18:00:00.000Z"))).toBe(true);
  });
});

describe("a failing connector still backs off, rather than retrying every slot", () => {
  it("waits out the widened gap even though slots keep passing", () => {
    const c = sched({ startAt: "2026-08-21T00:00:00.000Z", failures: 2, lastAttemptAt: "2026-08-21T12:00:00.000Z" });
    // factor 4 → 24h, so the 18:00 and 00:00 slots are skipped.
    expect(isDue(c, at("2026-08-21T18:00:00.000Z"))).toBe(false);
    expect(isDue(c, at("2026-08-22T12:00:00.000Z"))).toBe(true);
  });
});

describe("without a first run time nothing changes", () => {
  it("still counts the interval from the last attempt", () => {
    const c = sched({ everyMinutes: 60, lastAttemptAt: "2026-08-21T11:50:00.000Z" });
    expect(nextRunAt(c, NOW)).toBe("2026-08-21T12:50:00.000Z");
    expect(isDue(c, NOW)).toBe(false);
  });
});

describe("setConnectorSchedule", () => {
  const ids: string[] = [];
  const connector = (id: string, schedule?: Partial<NonNullable<AdapterConfig["schedule"]>>) => {
    writeSidecar({
      id, kind: "connector", boundedContext: "SAP", targetEntity: "PurchaseOrder",
      phase: "built", mode: "live", organizationId: "org-1", workflowId: "wf-1",
      ...(schedule ? { schedule: { enabled: true, everyMinutes: 360, ...schedule } } : {}),
    } as AdapterConfig);
    ids.push(id);
    return id;
  };

  const SFX = `sa${Date.now().toString(36)}`;

  it("stores the first run time as UTC whatever form it arrives in", () => {
    const id = connector(`start-${SFX}`);
    const s = setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: "2026-08-21T12:00:00+02:00" });
    expect(s.startAt).toBe("2026-08-21T10:00:00.000Z");
  });

  it("refuses a start time it cannot read, rather than silently ignoring it", () => {
    const id = connector(`bad-${SFX}`);
    expect(() => setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: "next tuesday-ish" }))
      .toThrow(ScheduleError);
    expect(readSidecar(id)?.schedule?.startAt).toBeUndefined();
  });

  it("refuses an epoch number rather than guessing seconds or milliseconds", () => {
    const id = connector(`epoch-${SFX}`);
    expect(() => setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: 1690000000000 }))
      .toThrow(ScheduleError);
    expect(() => setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: 1690000000 }))
      .toThrow(ScheduleError);
    expect(readSidecar(id)?.schedule?.startAt).toBeUndefined();
  });

  it("keeps the start time when polling is turned off and back on", () => {
    const id = connector(`keep-${SFX}`);
    setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: "2026-08-21T12:00:00.000Z" });
    setConnectorSchedule(id, { enabled: false, everyMinutes: 360 });
    expect(readSidecar(id)?.schedule?.startAt).toBe("2026-08-21T12:00:00.000Z");
    const back = setConnectorSchedule(id, { enabled: true, everyMinutes: 360 });
    expect(back.startAt).toBe("2026-08-21T12:00:00.000Z");
  });

  it("clears it on an empty string, going back to counting from the last run", () => {
    const id = connector(`clear-${SFX}`);
    setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: "2026-08-21T12:00:00.000Z" });
    const s = setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: "" });
    expect(s.startAt).toBeUndefined();
  });

  it("leaves it untouched when the caller says nothing about it", () => {
    const id = connector(`silent-${SFX}`);
    setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: "2026-08-21T12:00:00.000Z" });
    const s = setConnectorSchedule(id, { enabled: true, everyMinutes: 60 });
    expect(s.startAt).toBe("2026-08-21T12:00:00.000Z");
    expect(s.everyMinutes).toBe(60);
  });

  it("records the first run time in the history", () => {
    const id = connector(`note-${SFX}`);
    setConnectorSchedule(id, { enabled: true, everyMinutes: 360, startAt: "2026-08-21T12:00:00.000Z" });
    expect(readSidecar(id)).toBeTruthy();
  });

  afterAll(() => {
    for (const id of ids) {
      deleteSidecar(id);
    }
  });
});
