import { describe, it, expect } from "vitest";
import { isDue, nextRunAt, SCHEDULE_MIN_MINUTES } from "../../src/packs/scheduler.js";
import type { AdapterConfig } from "../../src/packs/types.js";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const agoMin = (m: number) => new Date(NOW - m * 60_000).toISOString();

function cfg(over: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    id: "sap-purchaseorder",
    kind: "connector",
    boundedContext: "SAP",
    targetEntity: "PurchaseOrder",
    phase: "raw",
    mode: "live",
    organizationId: "org-1",
    workflowId: "wf-1",
    schedule: { enabled: true, everyMinutes: 60 },
    ...over,
  } as AdapterConfig;
}

const sched = (s: Partial<NonNullable<AdapterConfig["schedule"]>>) =>
  cfg({ schedule: { enabled: true, everyMinutes: 60, ...s } });

describe("isDue — basics", () => {
  it("runs a never-run connector immediately", () => {
    expect(isDue(cfg(), NOW)).toBe(true);
  });

  it("waits out the interval, then fires", () => {
    expect(isDue(sched({ lastAttemptAt: agoMin(59) }), NOW)).toBe(false);
    expect(isDue(sched({ lastAttemptAt: agoMin(60) }), NOW)).toBe(true);
  });

  it("ignores a disabled schedule, and one that was never configured", () => {
    expect(isDue(sched({ enabled: false }), NOW)).toBe(false);
    expect(isDue(cfg({ schedule: undefined }), NOW)).toBe(false);
  });
});

describe("isDue — the backoff clock is the last ATTEMPT, not the last success", () => {
  it("uses lastAttemptAt even when lastPullAt is much older", () => {
    const c = cfg({ lastPullAt: agoMin(600), schedule: { enabled: true, everyMinutes: 60, lastAttemptAt: agoMin(5) } });
    expect(isDue(c, NOW)).toBe(false);
  });

  it("falls back to lastPullAt when the connector has never been scheduled-run", () => {
    expect(isDue(cfg({ lastPullAt: agoMin(10) }), NOW)).toBe(false);
    expect(isDue(cfg({ lastPullAt: agoMin(90) }), NOW)).toBe(true);
  });

  it("backs off exponentially after failures, and caps", () => {
    expect(isDue(sched({ failures: 1, lastAttemptAt: agoMin(90) }), NOW)).toBe(false); // needs 120
    expect(isDue(sched({ failures: 1, lastAttemptAt: agoMin(120) }), NOW)).toBe(true);
    expect(isDue(sched({ failures: 3, lastAttemptAt: agoMin(400) }), NOW)).toBe(false); // needs 480
    expect(isDue(sched({ failures: 3, lastAttemptAt: agoMin(480) }), NOW)).toBe(true);
    expect(isDue(sched({ failures: 99, lastAttemptAt: agoMin(60 * 16) }), NOW)).toBe(true);
  });
});

describe("isDue — safety guards", () => {
  it("refuses an adapter with no tenant stamp rather than guessing", () => {
    expect(isDue(cfg({ organizationId: undefined }), NOW)).toBe(false);
    expect(isDue(cfg({ workflowId: undefined }), NOW)).toBe(false);
    expect(isDue(cfg({ organizationId: null, workflowId: null }), NOW)).toBe(false);
  });

  it("refuses an interval below the floor, even if a sidecar was hand-edited", () => {
    expect(isDue(sched({ everyMinutes: SCHEDULE_MIN_MINUTES - 1 }), NOW)).toBe(false);
    expect(isDue(sched({ everyMinutes: 0 }), NOW)).toBe(false);
    expect(isDue(sched({ everyMinutes: -60 }), NOW)).toBe(false);
    expect(isDue(sched({ everyMinutes: SCHEDULE_MIN_MINUTES }), NOW)).toBe(true);
  });

  it("refuses a non-numeric interval", () => {
    expect(isDue(sched({ everyMinutes: NaN }), NOW)).toBe(false);
    expect(isDue(sched({ everyMinutes: "60" as unknown as number }), NOW)).toBe(false);
  });

  it("treats an unparseable timestamp as never-run instead of never firing again", () => {
    expect(isDue(sched({ lastAttemptAt: "not-a-date" }), NOW)).toBe(true);
  });
});

describe("isDue — a corrupt failure count must not wedge the schedule", () => {
  it("treats a non-numeric or negative failure count as none", () => {
    expect(isDue(sched({ failures: NaN as unknown as number, lastAttemptAt: agoMin(90) }), NOW)).toBe(true);
    expect(isDue(sched({ failures: "x" as unknown as number, lastAttemptAt: agoMin(90) }), NOW)).toBe(true);
    expect(isDue(sched({ failures: -5, lastAttemptAt: agoMin(90) }), NOW)).toBe(true);
  });
});

describe("nextRunAt", () => {
  it("is null unless polling is on with a usable interval", () => {
    expect(nextRunAt(sched({ enabled: false }))).toBeNull();
    expect(nextRunAt(cfg({ schedule: undefined }))).toBeNull();
    expect(nextRunAt(sched({ everyMinutes: 1 }))).toBeNull();
  });

  it("adds the interval to the last attempt", () => {
    const at = nextRunAt(sched({ lastAttemptAt: agoMin(10) }))!;
    expect(Date.parse(at)).toBe(NOW - 10 * 60_000 + 60 * 60_000);
  });

  it("stretches by the same backoff isDue applies, so the UI can't disagree", () => {
    const at = nextRunAt(sched({ failures: 3, lastAttemptAt: agoMin(0) }))!;
    expect(Date.parse(at)).toBe(NOW + 8 * 60 * 60_000);
  });
});
