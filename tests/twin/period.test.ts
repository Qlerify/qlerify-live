// Period-scoped ("cycle") aggregate primitives: the key parsing that declares a
// cycle, the UTC period bucketing children correlate through, and the canonical
// cycle row id. All pure — no DB / disk / tenant context.

import { describe, it, expect } from "vitest";
import type { EntitySchema } from "../../src/ontology/model.js";
import {
  granularityOf, periodKeyOf, isPeriodScoped, periodOf, periodStart, cycleId, periodFormatExample,
} from "../../src/twin/period.js";

const entity = (key: string[] | undefined, fieldNames: string[]): EntitySchema => ({
  name: "T",
  required: [],
  fields: fieldNames.map((name) => ({ name })),
  ...(key ? { key } : {}),
});

describe("periodKeyOf — what makes an entity a cycle", () => {
  it("parses a subject + period composite key", () => {
    const pk = periodKeyOf(entity(["hubspotCompanyId", "quarter"], ["id", "hubspotCompanyId", "quarter", "name"]));
    expect(pk).toEqual({ subjectFields: ["hubspotCompanyId"], periodField: "quarter", granularity: "quarter" });
  });

  it("is null for the export's default ['id'] key (not period-scoped)", () => {
    expect(periodKeyOf(entity(["id"], ["id", "name"]))).toBeNull();
    expect(periodKeyOf(entity(undefined, ["id", "name"]))).toBeNull();
  });

  it("is null without a period-named key field, or without a subject beside it", () => {
    expect(periodKeyOf(entity(["companyId", "region"], ["id", "companyId", "region"]))).toBeNull();
    expect(periodKeyOf(entity(["id", "quarter"], ["id", "quarter"]))).toBeNull(); // period alone
  });

  it("is void when the key names an undeclared field (stale key must not half-apply)", () => {
    expect(periodKeyOf(entity(["companyId", "quarter"], ["id", "quarter"]))).toBeNull();
  });

  it("recognises granularities by name, including suffixed names", () => {
    expect(granularityOf("quarter")).toBe("quarter");
    expect(granularityOf("fiscalQuarter")).toBe("quarter");
    expect(granularityOf("month")).toBe("month");
    expect(granularityOf("name")).toBeUndefined();
    expect(isPeriodScoped(entity(["companyId", "month"], ["id", "companyId", "month"]))).toBe(true);
  });
});

describe("periodOf — UTC bucketing in the canonical formats", () => {
  it("buckets quarters, with exact boundary dates", () => {
    expect(periodOf(new Date("2026-08-14T10:00:00Z"), "quarter")).toBe("2026Q3");
    expect(periodOf(new Date("2026-03-31T23:59:59Z"), "quarter")).toBe("2026Q1");
    expect(periodOf(new Date("2026-04-01T00:00:00Z"), "quarter")).toBe("2026Q2");
    expect(periodOf(new Date("2026-12-31T23:59:59Z"), "quarter")).toBe("2026Q4");
    expect(periodOf(new Date("2027-01-01T00:00:00Z"), "quarter")).toBe("2027Q1");
  });

  it("buckets months and years", () => {
    expect(periodOf(new Date("2026-08-14T10:00:00Z"), "month")).toBe("2026-08");
    expect(periodOf(new Date("2026-01-31T00:00:00Z"), "month")).toBe("2026-01");
    expect(periodOf(new Date("2026-08-14T10:00:00Z"), "year")).toBe("2026");
  });

  it("buckets ISO weeks, including the year rollover", () => {
    expect(periodOf(new Date("2026-01-01T00:00:00Z"), "week")).toBe("2026-W01"); // a Thursday
    expect(periodOf(new Date("2024-12-30T00:00:00Z"), "week")).toBe("2025-W01"); // Monday of NEXT iso-year's week 1
  });
});

describe("periodStart — the period's opening instant (lazy cycle anchor)", () => {
  it("round-trips with periodOf", () => {
    for (const [p, g] of [
      ["2026Q3", "quarter"],
      ["2026-08", "month"],
      ["2026", "year"],
      ["2026-W01", "week"],
    ] as const) {
      const start = periodStart(p, g);
      expect(start).not.toBeNull();
      expect(periodOf(start!, g)).toBe(p);
    }
  });

  it("parses the canonical formats exactly", () => {
    expect(periodStart("2026Q3", "quarter")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(periodStart("2026-W01", "week")?.toISOString()).toBe("2025-12-29T00:00:00.000Z");
    expect(periodStart("Q3 2026", "quarter")).toBeNull(); // wrong format → no fabricated date
    expect(periodStart("2026-13", "month")).toBeNull();
  });
});

describe("cycleId — the engine-composed canonical row id", () => {
  it("joins subject value(s) and period with @", () => {
    expect(cycleId(["hubspot-company-3379727147"], "2026Q3")).toBe("hubspot-company-3379727147@2026Q3");
    expect(cycleId(["a", "b"], "2026-08")).toBe("a@b@2026-08");
  });

  it("has a documented example format per granularity", () => {
    expect(periodFormatExample("quarter")).toBe("2026Q3");
    expect(periodFormatExample("week")).toBe("2026-W32");
  });
});
