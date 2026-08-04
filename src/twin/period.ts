// Period-scoped ("cycle") aggregates — the recurring-process primitive.
//
// A cycle aggregate is a root whose identity is subject × period: "Company X's
// 2026Q3 quarterly cycle". The model declares it through the entity's composite
// natural `key` (e.g. ["hubspotCompanyId", "quarter"]): the key fields that name
// a period granularity (quarter/month/week/year) form the PERIOD part, the rest
// form the SUBJECT the cycle recurs for. Everything else — which period a child
// event belongs to, the canonical row id — is derived here, so neither modelers
// nor connectors ever compose composite keys by hand.
//
// A child of a cycle carries only its subject FK; its PERIOD comes from its own
// business date (bucketed by periodOf). The period is deliberately never stored
// on children — it is derivable from the date, and a stored copy could disagree
// with it.
//
// All bucketing is UTC: business dates arrive as ISO strings and a period
// boundary must not shift with the server's locale.

import type { EntitySchema } from "../ontology/model.js";

export type PeriodGranularity = "quarter" | "month" | "week" | "year";

const GRANULARITIES: PeriodGranularity[] = ["quarter", "month", "week", "year"];

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The period granularity a key-field NAME declares ("quarter" → quarter,
 * "fiscalQuarter" → quarter), or undefined for a non-period field. */
export function granularityOf(fieldName: string): PeriodGranularity | undefined {
  const n = normName(fieldName);
  return GRANULARITIES.find((g) => n === g || n.endsWith(g));
}

/** The parsed composite natural key of a period-scoped entity. */
export interface PeriodKey {
  /** Subject key fields — the business identity the cycle recurs FOR
   * (e.g. ["hubspotCompanyId"]). Never includes the surrogate `id`. */
  subjectFields: string[];
  /** The key field holding the period value (e.g. "quarter"). */
  periodField: string;
  granularity: PeriodGranularity;
}

/** Parse an entity's declared `key` into subject + period, or null when the
 * entity is NOT period-scoped: no key, a bare ["id"] key, no period-named key
 * field, no subject field left beside it, or a key naming an undeclared field
 * (a stale key must never silently half-apply). */
export function periodKeyOf(entity: EntitySchema): PeriodKey | null {
  const key = entity.key ?? [];
  if (key.length < 2) return null;
  const declared = new Set(entity.fields.map((f) => f.name));
  let periodField: string | undefined;
  let granularity: PeriodGranularity | undefined;
  const subjectFields: string[] = [];
  for (const name of key) {
    if (name === "id") continue;
    if (!declared.has(name)) return null;
    const g = periodField ? undefined : granularityOf(name);
    if (g) {
      periodField = name;
      granularity = g;
    } else {
      subjectFields.push(name);
    }
  }
  if (!periodField || !granularity || subjectFields.length === 0) return null;
  return { subjectFields, periodField, granularity };
}

/** Is this entity a period-scoped cycle aggregate? */
export function isPeriodScoped(entity: EntitySchema): boolean {
  return periodKeyOf(entity) !== null;
}

/** Canonical period value containing `date`, per granularity:
 * quarter "2026Q3" · month "2026-08" · week "2026-W32" (ISO 8601) · year "2026".
 * These exact formats are the contract: connectors that populate a cycle's
 * period field must emit them verbatim, and equality against them is how a
 * child's business date finds its cycle row. */
export function periodOf(date: Date, granularity: PeriodGranularity): string {
  const y = date.getUTCFullYear();
  switch (granularity) {
    case "quarter":
      return `${y}Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
    case "month":
      return `${y}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    case "year":
      return String(y);
    case "week": {
      // ISO 8601 week: shift to the Thursday of this week; its year owns the week.
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const isoYear = d.getUTCFullYear();
      const week = Math.ceil(((d.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7);
      return `${isoYear}-W${String(week).padStart(2, "0")}`;
    }
  }
}

/** The instant a period value begins (UTC), or null for a value that doesn't
 * parse as the granularity's canonical format. Used as the nominal businessAt
 * of a lazily-opened cycle (its CycleStarted is estimated, not witnessed). */
export function periodStart(period: string, granularity: PeriodGranularity): Date | null {
  switch (granularity) {
    case "quarter": {
      const m = /^(\d{4})Q([1-4])$/.exec(period);
      return m ? new Date(Date.UTC(Number(m[1]), (Number(m[2]) - 1) * 3, 1)) : null;
    }
    case "month": {
      const m = /^(\d{4})-(\d{2})$/.exec(period);
      if (!m) return null;
      const mo = Number(m[2]);
      return mo >= 1 && mo <= 12 ? new Date(Date.UTC(Number(m[1]), mo - 1, 1)) : null;
    }
    case "year": {
      const m = /^(\d{4})$/.exec(period);
      return m ? new Date(Date.UTC(Number(m[1]), 0, 1)) : null;
    }
    case "week": {
      const m = /^(\d{4})-W(\d{2})$/.exec(period);
      if (!m) return null;
      const w = Number(m[2]);
      if (w < 1 || w > 53) return null;
      // ISO week 1 always contains Jan 4; back up to that week's Monday.
      const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
      const day = jan4.getUTCDay() || 7;
      jan4.setUTCDate(jan4.getUTCDate() - (day - 1) + (w - 1) * 7);
      return jan4;
    }
  }
}

/** An example period value per granularity — for generated operator/AI guidance. */
export function periodFormatExample(granularity: PeriodGranularity): string {
  switch (granularity) {
    case "quarter": return "2026Q3";
    case "month": return "2026-08";
    case "week": return "2026-W32";
    case "year": return "2026";
  }
}

/** Canonical row id of a cycle instance: the subject key value(s) + the period,
 * "@"-joined (e.g. "hubspot-company-3379727147@2026Q3"). Engine-composed —
 * connectors never build this; correlation never parses it (resolution matches
 * on the subject/period FIELD VALUES, so pre-existing rows with legacy ids
 * still resolve). */
export function cycleId(subjectValues: string[], period: string): string {
  return [...subjectValues, period].join("@");
}
