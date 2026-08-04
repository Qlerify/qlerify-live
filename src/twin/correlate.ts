// Model-driven case correlation.
//
// A "case" is one end-to-end run of a workflow. Its id (EventLog.caseId) is the
// id of the instance that STARTED the run — the first aggregate created. A single
// case can span SEVERAL aggregate roots: the workflow moves from aggregate A into
// aggregate B, and B's events must stay attached to the SAME case as A.
//
// The simulator pins this explicitly (bus.withScope), so its runs never break.
// The break happens on the DERIVE / fallback path — events reconstructed from
// ingested rows, or a one-off command dispatched outside a run — where each
// aggregate would otherwise be scoped to its OWN id and start a separate case,
// fragmenting one real-world case into one-per-aggregate.
//
// This module reconnects them with a model-agnostic heuristic: if the aggregate
// we are moving into carries a foreign-key reference back to an aggregate that is
// already part of a case, it belongs to that same case. Because the parent was
// correlated the same way, inheriting its caseId transitively walks all the way
// back to the case root. Nothing here is workflow-specific: the FK relationships
// come entirely from the loaded model.
//
// SHAPE (mirrors twin/derive.ts): decideCaseId() is the PURE model-driven core —
// given the model, the aggregate, its payload, and a resolver from instance-id to
// caseId, it returns the case with no DB or I/O. correlateCaseId() is the thin
// wrapper: it batches the one EventLog lookup (tenant-scoped) the resolver needs.

import { prisma } from "../db.js";
import { getOntology, type Ontology } from "../ontology/model.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { periodKeyOf, periodOf, type PeriodGranularity } from "./period.js";
import * as store from "./projection-store.js";

/** The entity an `<name>Id` field points at (the FK-by-name heuristic, shared
 * with the simulator's arg-linking). Matched case-insensitively so acronym
 * entities resolve too — "gprId" → "GPR", "soaId" → "SoA" — and the entity's
 * REAL name is returned. Undefined when the field isn't `*Id`-shaped or no
 * entity matches. */
export function fkTargetEntity(fieldName: string, ont: Ontology): string | undefined {
  const m = /^(.+)Id$/.exec(fieldName);
  if (!m) return undefined;
  const want = m[1]!.toLowerCase();
  return ont.entities.find((e) => e.name.toLowerCase() === want)?.name;
}

/** Foreign-key fields on `aggregateRoot` that point at ANOTHER aggregate entity,
 * resolved from the model: a field whose declared `relatedEntity` is an entity,
 * or an `<name>Id` field whose `<Name>` is an entity (the FK-by-name heuristic,
 * the same one the simulator uses to link args). The aggregate's own surrogate
 * `id` is never an FK, and a self-reference is ignored. References that point
 * straight at the case ROOT aggregate are tried first — that's the spine of the
 * case — so a row linking to several aggregates prefers the most direct anchor. */
export function foreignKeyFields(aggregateRoot: string, ont: Ontology): Array<{ name: string; target: string }> {
  const entity = ont.entity(aggregateRoot);
  if (!entity) return [];
  const root = ont.rootAggregate;
  const out: Array<{ name: string; target: string }> = [];
  for (const f of entity.fields) {
    if (f.name === "id") continue;
    let target: string | undefined;
    if (f.relatedEntity && ont.entity(f.relatedEntity)) {
      target = f.relatedEntity;
    } else {
      target = fkTargetEntity(f.name, ont);
    }
    if (target && target !== aggregateRoot) out.push({ name: f.name, target });
  }
  out.sort((a, b) => Number(b.target === root) - Number(a.target === root));
  return out;
}

// --- Period-scoped cycle links ----------------------------------------------
// A cycle aggregate (twin/period.ts) is identified by subject × period. A child
// row does NOT carry the cycle row's id — it carries the cycle's SUBJECT key
// (e.g. Meeting.companyId ↔ Quarter.hubspotCompanyId) and its own business date
// supplies the period. The link below is resolved from the model alone; the
// VALUE resolution (which cycle row those coordinates name) is the caller's.

/** A model-declared path from a child aggregate into a period-scoped cycle. */
export interface CycleLink {
  /** The period-scoped target entity (e.g. "Quarter"). */
  target: string;
  /** Child payload field ↔ target subject key field, one pair per subject field. */
  subjectFields: Array<{ child: string; subject: string }>;
  /** The target's period key field (e.g. "quarter"). */
  periodField: string;
  granularity: PeriodGranularity;
}

const normField = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Does a child field NAME reference a cycle's subject key field? Exact match,
 * or an id-shaped suffix relation in either direction — "companyId" matches
 * subject "hubspotCompanyId" (and vice versa), so renaming the cycle ENTITY
 * (the break that motivated all this) can never sever the link: the match is
 * against the subject FIELD, not the entity name. */
function subjectFieldMatch(childField: string, subjectField: string): boolean {
  const c = normField(childField);
  const s = normField(subjectField);
  if (c === s) return true;
  if (!c.endsWith("id") || !s.endsWith("id")) return false;
  return c.endsWith(s) || s.endsWith(c);
}

/** Cycle links from `aggregateRoot` into every period-scoped entity whose FULL
 * subject key its fields cover (a partial subject match is no link — half a
 * composite key must never correlate). Links into the case ROOT aggregate come
 * first, mirroring foreignKeyFields' spine-first ordering. Self-links are
 * meaningless (the cycle row IS its own case anchor) and excluded. */
export function cycleLinkFields(aggregateRoot: string, ont: Ontology): CycleLink[] {
  const entity = ont.entity(aggregateRoot);
  if (!entity) return [];
  const out: CycleLink[] = [];
  for (const target of ont.entities) {
    if (target.name === aggregateRoot) continue;
    const pk = periodKeyOf(target);
    if (!pk) continue;
    const pairs: Array<{ child: string; subject: string }> = [];
    for (const subject of pk.subjectFields) {
      const child = entity.fields.find((f) => f.name !== "id" && subjectFieldMatch(f.name, subject));
      if (!child) break;
      pairs.push({ child: child.name, subject });
    }
    if (pairs.length !== pk.subjectFields.length) continue;
    out.push({ target: target.name, subjectFields: pairs, periodField: pk.periodField, granularity: pk.granularity });
  }
  out.sort((a, b) => Number(b.target === ont.rootAggregate) - Number(a.target === ont.rootAggregate));
  return out;
}

/** The child-side subject key values a payload carries for a link, or null when
 * any is missing/blank (a partial subject must never resolve). */
export function subjectValues(link: CycleLink, payload: Record<string, unknown>): string[] | null {
  const out: string[] = [];
  for (const pair of link.subjectFields) {
    const v = payload[pair.child];
    if (typeof v !== "string" || !v.trim()) return null;
    out.push(v);
  }
  return out;
}

/** Optional cycle-resolution context for decideCaseId. `businessAt` is the
 * event's business date (the period source); `cycleCase` resolves the case of
 * the cycle row at (target, subject values, period) — null when no such row is
 * known. Injected so the pure core stays I/O-free. */
export interface CycleResolution {
  businessAt: Date | null;
  cycleCase: (link: CycleLink, values: string[], period: string) => string | null;
}

/** PURE correlation decision. Given the model, the aggregate being scoped, its
 * payload, and `caseOf` (an instance-id → caseId resolver over already-recorded
 * events), decide the caseId:
 *
 *  1. An explicit `caseId` in the payload always wins.
 *  2. The root aggregate starts its own case (caseId = its own id).
 *  3. An instance already attached to a case keeps that case (idempotent
 *     re-derive; a later event on an aggregate whose create already correlated).
 *  4. Otherwise follow a foreign-key reference back to a parent aggregate already
 *     in a case, and inherit it.
 *  5. Otherwise follow a CYCLE link: the payload's subject key values + the
 *     event's business date bucketed to a period name a period-scoped cycle row
 *     (Meeting.companyId + quarterOf(scheduledAt) → the Quarter case).
 *  6. With no resolvable link, start a fresh case (its own id).
 *
 * No DB or I/O — that's correlateCaseId()'s job. */
export function decideCaseId(
  ont: Ontology,
  aggregateRoot: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  caseOf: (instanceId: string) => string | null,
  cycle?: CycleResolution,
): string | null {
  if (typeof payload.caseId === "string" && payload.caseId) return payload.caseId;
  if (!aggregateId) return null;
  if (aggregateRoot === ont.rootAggregate) return aggregateId;

  const self = caseOf(aggregateId);
  if (self) return self;

  for (const fk of foreignKeyFields(aggregateRoot, ont)) {
    const ref = payload[fk.name];
    if (typeof ref !== "string" || !ref) continue;
    const parentCase = caseOf(ref);
    if (parentCase) return parentCase;
  }

  if (cycle?.businessAt) {
    for (const link of cycleLinkFields(aggregateRoot, ont)) {
      const values = subjectValues(link, payload);
      if (!values) continue;
      const c = cycle.cycleCase(link, values, periodOf(cycle.businessAt, link.granularity));
      if (c) return c;
    }
  }

  return aggregateId;
}

/** Stable lookup key for a pre-resolved cycle coordinate. */
const cycleCoordKey = (target: string, values: string[], period: string): string =>
  [target, ...values, period].join("\u0000");

/** The caseId an aggregate instance belongs to (the thin I/O wrapper around
 * decideCaseId). Resolves `caseOf` with ONE tenant-scoped EventLog lookup over
 * the candidate ids — the instance itself plus the FK references its payload
 * carries — so it never correlates across orgs/workflows. `businessAt` (the
 * event's business date, resolved by the caller) enables cycle-link resolution:
 * each candidate cycle row is looked up by its subject + period COLUMN VALUES in
 * the projection store (never by id shape), then joins the candidate set. This
 * path only READS — a missing cycle row falls through; lazy cycle instantiation
 * lives on the derive path (twin/derive.ts), the data path that owns rows. */
export async function correlateCaseId(
  aggregateRoot: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  businessAt?: Date | null,
): Promise<string | null> {
  if (typeof payload.caseId === "string" && payload.caseId) return payload.caseId;
  if (!aggregateId) return null;

  let ont: Ontology;
  try {
    ont = getOntology();
  } catch {
    return aggregateId; // no model loaded → degrade to per-aggregate scoping
  }
  if (aggregateRoot === ont.rootAggregate) return aggregateId;

  // Candidate instance ids whose case we might inherit: this aggregate itself,
  // plus every FK reference the payload carries.
  const candidates = new Set<string>([aggregateId]);
  for (const fk of foreignKeyFields(aggregateRoot, ont)) {
    const ref = payload[fk.name];
    if (typeof ref === "string" && ref) candidates.add(ref);
  }

  // Pre-resolve cycle coordinates → cycle row id (value equality on the target's
  // subject + period columns), so the pure core can consult them without I/O.
  // The resolved row ids join the candidate set: the cycle row's own case (if it
  // has events) wins over anchoring on the bare row id.
  const cycleRowByCoord = new Map<string, string>();
  if (businessAt) {
    for (const link of cycleLinkFields(aggregateRoot, ont)) {
      const values = subjectValues(link, payload);
      if (!values || !(await store.tableExists(link.target))) continue;
      const period = periodOf(businessAt, link.granularity);
      const filters = [
        ...link.subjectFields.map((sf, i) => ({ attr: sf.subject, cond: "Equal to", value: values[i]! })),
        { attr: link.periodField, cond: "Equal to", value: period },
      ];
      const row = (await store.findMany(link.target, 1, 0, filters))[0];
      if (row?.id != null) {
        const rowId = String(row.id);
        cycleRowByCoord.set(cycleCoordKey(link.target, values, period), rowId);
        candidates.add(rowId);
      }
    }
  }

  const rows = await prisma.eventLog.findMany({
    where: { aggregateId: { in: [...candidates] }, caseId: { not: null }, ...eventLogOrgWhere() },
    orderBy: { occurredAt: "asc" },
    select: { aggregateId: true, caseId: true },
  });
  const caseByInstance = new Map<string, string>();
  for (const r of rows) {
    if (r.aggregateId && r.caseId && !caseByInstance.has(r.aggregateId)) caseByInstance.set(r.aggregateId, r.caseId);
  }

  return decideCaseId(ont, aggregateRoot, aggregateId, payload, (id) => caseByInstance.get(id) ?? null, {
    businessAt: businessAt ?? null,
    cycleCase: (link, values, period) => {
      const rowId = cycleRowByCoord.get(cycleCoordKey(link.target, values, period));
      return rowId ? caseByInstance.get(rowId) ?? rowId : null;
    },
  });
}
