// Model-driven event derivation from ingested data.
//
// Ingestion (packs/ingest.ts) lands real rows in the gen_ projection tables but
// emits NO domain events — its own comment defers that ("RawEvent/BusinessEvent
// split + emitting … are Part 5"). This module closes that gap: it reads the
// ingested aggregate rows and, for each model domain event, decides FROM THE
// ROW'S OWN STATE whether that event's evidence is present, then emits the
// implied events into the EventLog (the same emit() chokepoint commands use),
// scoped per aggregate instance so the dashboard lights up.
//
// Everything here is derived from the LOADED MODEL — no per-workflow code:
//   • CREATE event  → evidence = the row exists AND the entity's required
//                     business fields are populated (Account Registered ⇐
//                     email + firstname + lastname present).
//   • STATUS event  → the event drives the aggregate into a status value named
//                     in the event (or its Then-clause); evidence = the row's
//                     status is at-or-beyond that value on the status ladder
//                     (Account Confirmed ⇐ status == CONFIRMED).
//   • FIELD event   → an update event introducing its own entity-column field(s)
//                     not seen on any earlier event for the aggregate; evidence
//                     = those fields are set.
//   • else          → no row-state evidence (e.g. a login that leaves no trace);
//                     skipped, with the reason recorded.
//
// It NEVER writes to the gen_ tables (the rows are already there) and is
// idempotent: an event already in the log for an aggregate id is not re-emitted,
// so a re-run only fills gaps and a synthetic simulator run is left untouched.
//
// The derived event carries the ROW's provenance (recorded/live/simulated) — a
// real ingested Account yields a real-looking AccountRegistered. The only thing
// "simulated" is the ordering/timing (businessAt), which is nominal.
//
// SHAPE: planDerivation() is the PURE model-driven core (no DB, no I/O) — given
// an ontology and the rows per entity it returns exactly which events would fire
// and why. deriveFromData() is the thin I/O wrapper: read rows from the store,
// run the planner, skip events already in the log, and emit the rest.

import { prisma } from "../db.js";
import { emit } from "../events/bus.js";
import { setBusinessClock } from "../events/clock.js";
import { getOntology, type Ontology, type OntologyEvent, type EntitySchema } from "../ontology/model.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { PROV_MODES, type ProvMode } from "./provenance.js";
import * as store from "./projection-store.js";

// Platform / internal columns that are never business evidence and never part of
// a derived event's payload.
const PLATFORM_COLS = new Set(["version", "createdAt", "updatedAt", "_provenance", "organization_id"]);

export type EvidenceKind = "create" | "status" | "fields" | "none";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function present(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

/** True when this event is the first to touch its own aggregate in the follows
 * DAG (no transitive predecessor shares its aggregateRoot) — the create shape.
 * Mirrors the same test in commands/base.ts and twin/sim.ts. */
function isCreateEvent(event: OntologyEvent, ont: Ontology): boolean {
  const seen = new Set<string>();
  const stack = [...event.predecessors];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const pe = ont.eventByKey(k);
    if (!pe) continue;
    if (pe.aggregateRoot === event.aggregateRoot) return false;
    stack.push(...pe.predecessors);
  }
  return true;
}

/** The entity's required fields that are real business evidence (drop the
 * surrogate id and the platform columns). */
function requiredBusinessFields(entity: EntitySchema): string[] {
  return (entity.required ?? []).filter((n) => n !== "id" && !PLATFORM_COLS.has(n));
}

/** The status field's example values, de-duplicated and order-preserved — the
 * canonical lifecycle ladder (e.g. ["UNCONFIRMED", "CONFIRMED"]). Empty when the
 * aggregate has no status field or no examples. */
function statusLadder(entity: EntitySchema): string[] {
  const f = entity.fields.find((x) => x.name === "status");
  const ex = f?.exampleData;
  if (!Array.isArray(ex)) return [];
  const out: string[] = [];
  for (const v of ex) {
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Text of the Then-clauses across the event's acceptance criteria — the
 * resulting state, excluding the Given-clause preconditions (so "Given a
 * confirmed account" on a login event does NOT read as a status target). */
function thenText(event: OntologyEvent): string {
  return event.acceptanceCriteria
    .map((ac) => {
      const m = /\bthen\b/i.exec(ac);
      return m ? ac.slice(m.index + m[0].length) : "";
    })
    .join(" ");
}

/** The ladder index this event drives the aggregate INTO, or -1. The event name
 * is the primary signal (past-tense event names embed the resulting state, e.g.
 * "Account Confirmed" → CONFIRMED); the Then-clause is the fallback. Higher ladder
 * values win, so a multi-step transition resolves to its furthest state. */
function statusTargetIndex(event: OntologyEvent, entity: EntitySchema): number {
  const ladder = statusLadder(entity);
  if (ladder.length === 0) return -1;
  const name = norm(event.name + " " + event.key);
  for (let i = ladder.length - 1; i >= 0; i--) {
    if (ladder[i] && name.includes(norm(ladder[i]!))) return i;
  }
  const then = norm(thenText(event));
  for (let i = ladder.length - 1; i >= 0; i--) {
    if (ladder[i] && then.includes(norm(ladder[i]!))) return i;
  }
  return -1;
}

/** Entity-column fields this event's command INTRODUCES — present on its command,
 * a real column, and not already carried by any earlier same-aggregate event
 * (so a field shared with the create, like `email`, is not evidence for a later
 * event). This is what makes a login event — whose fields all came from register
 * — yield no distinguishing evidence. */
function distinguishingFields(event: OntologyEvent, entity: EntitySchema, ont: Ontology): string[] {
  const cmd = ont.command(event.commandName);
  if (!cmd) return [];
  const entityCols = new Set(entity.fields.map((f) => f.name));
  const order = ont.linearOrder();
  const myIdx = order.indexOf(event.key);
  const earlier = new Set<string>();
  for (let i = 0; i < order.length && i < myIdx; i++) {
    const e = ont.eventByKey(order[i]!);
    if (!e || e.aggregateRoot !== event.aggregateRoot) continue;
    for (const f of ont.command(e.commandName)?.fields ?? []) earlier.add(f.name);
  }
  return cmd.fields
    .map((f) => f.name)
    .filter((n) => n !== "id" && n !== "status" && entityCols.has(n) && !earlier.has(n));
}

/** Which evidence rule applies to this event — fixed by the model (event +
 * entity), independent of any particular row. */
function classify(event: OntologyEvent, entity: EntitySchema, ont: Ontology): EvidenceKind {
  if (isCreateEvent(event, ont)) return "create";
  if (statusTargetIndex(event, entity) >= 0) return "status";
  if (distinguishingFields(event, entity, ont).length > 0) return "fields";
  return "none";
}

/** Evaluate a single row against the event's evidence rule. */
function evaluate(
  kind: EvidenceKind,
  event: OntologyEvent,
  row: Record<string, unknown>,
  entity: EntitySchema,
  ont: Ontology,
): { happened: boolean; reason: string } {
  switch (kind) {
    case "create": {
      const req = requiredBusinessFields(entity);
      const missing = req.filter((n) => !present(row[n]));
      if (missing.length === 0) {
        return { happened: true, reason: req.length ? `row exists; required present (${req.join(", ")})` : "row exists" };
      }
      return { happened: false, reason: `missing required: ${missing.join(", ")}` };
    }
    case "status": {
      const ladder = statusLadder(entity);
      const tgt = statusTargetIndex(event, entity);
      const cur = ladder.indexOf(String(row.status));
      if (cur >= 0 && cur >= tgt) return { happened: true, reason: `status=${row.status} (≥ ${ladder[tgt]})` };
      return { happened: false, reason: `status=${row.status ?? "∅"} (< ${ladder[tgt]})` };
    }
    case "fields": {
      const dist = distinguishingFields(event, entity, ont);
      const missing = dist.filter((n) => !present(row[n]));
      if (missing.length === 0) return { happened: true, reason: dist.map((n) => `${n}=${row[n]}`).join(", ") };
      return { happened: false, reason: `unset: ${missing.join(", ")}` };
    }
    default:
      return { happened: false, reason: "no row-state evidence (action leaves no trace on the aggregate)" };
  }
}

/** A nominal business date for the row's events: the first date-typed business
 * column with a parseable value, else the row's createdAt, else now. Events are
 * then spread by their order index so an instance's timeline stays monotonic. */
function rowBaseDate(row: Record<string, unknown>, entity: EntitySchema): Date {
  const dateField = entity.fields.find(
    (f) => !PLATFORM_COLS.has(f.name) && f.name !== "id" && /date|time/i.test(f.dataType ?? "") && present(row[f.name]),
  );
  if (dateField) {
    const d = new Date(String(row[dateField.name]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (present(row.createdAt)) {
    const d = new Date(String(row.createdAt));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function rowProvenance(row: Record<string, unknown>): ProvMode | undefined {
  const p = row._provenance;
  return typeof p === "string" && (PROV_MODES as readonly string[]).includes(p) ? (p as ProvMode) : undefined;
}

/** The derived event's payload: the row's business fields (drop platform cols),
 * id always included. */
function buildPayload(row: Record<string, unknown>, entity: EntitySchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of entity.fields) {
    if (PLATFORM_COLS.has(f.name)) continue;
    if (row[f.name] !== undefined && row[f.name] !== null) out[f.name] = row[f.name];
  }
  out.id = String(row.id);
  return out;
}

/** One event the data implies happened for one aggregate instance — everything
 * emit() needs, plus the human-readable evidence. */
export interface PlannedEmission {
  ref: string;
  aggregateId: string;
  role: string;
  payload: Record<string, unknown>;
  businessAt: Date;
  provenance?: ProvMode;
  evidence: string;
}

/** Per-event outcome of the plan: what fired, and how many rows held no evidence. */
export interface EventPlan {
  key: string;
  name: string;
  aggregateRoot: string;
  kind: EvidenceKind;
  fired: PlannedEmission[];
  noEvidence: number;
}

/** PURE model-driven core: given the ontology and the rows per entity, decide
 * which events the data implies. No DB, no I/O, no idempotency — that's the
 * wrapper's job. Walks events in linear order so an instance's create precedes
 * its updates (and the businessAt spread stays monotonic). */
export function planDerivation(
  ont: Ontology,
  rowsByEntity: Map<string, Array<Record<string, unknown>>>,
): EventPlan[] {
  const order = ont.linearOrder();
  const plans: EventPlan[] = [];

  for (let oi = 0; oi < order.length; oi++) {
    const event = ont.eventByKey(order[oi]!);
    if (!event) continue;
    const entity = ont.entity(event.aggregateRoot);
    if (!entity) continue;
    const rows = rowsByEntity.get(entity.name) ?? [];
    if (rows.length === 0) continue;

    const kind = classify(event, entity, ont);
    const fired: PlannedEmission[] = [];
    let noEvidence = 0;

    for (const row of rows) {
      const id = String(row.id ?? "");
      if (!id) continue;
      const ev = evaluate(kind, event, row, entity, ont);
      if (!ev.happened) {
        noEvidence++;
        continue;
      }
      fired.push({
        ref: event.ref,
        aggregateId: id,
        role: event.role,
        payload: buildPayload(row, entity),
        businessAt: new Date(rowBaseDate(row, entity).getTime() + oi * 1000),
        provenance: rowProvenance(row),
        evidence: ev.reason,
      });
    }

    plans.push({ key: event.key, name: event.name, aggregateRoot: event.aggregateRoot, kind, fired, noEvidence });
  }

  return plans;
}

export interface DerivedEventSummary {
  key: string;
  name: string;
  aggregateRoot: string;
  kind: EvidenceKind;
  /** Rows whose evidence fired a (new) event. */
  emitted: number;
  /** Rows whose evidence held but the event was already in the log. */
  alreadyPresent: number;
  /** Rows considered whose evidence did not hold. */
  noEvidence: number;
  /** A representative evidence reason. */
  sample?: string;
}

export interface DeriveResult {
  preview: boolean;
  totalEmitted: number;
  /** Distinct aggregate instances that gained at least one event. */
  instances: number;
  events: DerivedEventSummary[];
  /** Event-log rows deleted before re-deriving. Only set by rebuildFromData(). */
  cleared?: number;
}

/** I/O wrapper: read the ingested rows from the store, plan the derivation, skip
 * events already in the log, and emit the rest. `preview: true` runs the plan and
 * the already-present check without emitting — the UI uses it to show what would
 * fire. Idempotent. */
export async function deriveFromData(opts: { preview?: boolean; limit?: number } = {}): Promise<DeriveResult> {
  const preview = !!opts.preview;
  const limit = opts.limit ?? 1000;
  const ont = getOntology();

  // Load the rows for every aggregate root that some event targets.
  const rowsByEntity = new Map<string, Array<Record<string, unknown>>>();
  for (const name of new Set(ont.events.map((e) => e.aggregateRoot))) {
    if (rowsByEntity.has(name)) continue;
    rowsByEntity.set(name, (await store.tableExists(name)) ? await store.findMany(name, limit) : []);
  }

  const plans = planDerivation(ont, rowsByEntity);
  const summaries: DerivedEventSummary[] = [];
  const touched = new Set<string>();
  let totalEmitted = 0;

  for (const plan of plans) {
    let emitted = 0;
    let already = 0;
    let sample: string | undefined = plan.fired[0]?.evidence;

    for (const e of plan.fired) {
      const existing = await prisma.eventLog.count({
        where: { eventRef: e.ref, aggregateId: e.aggregateId, ...eventLogOrgWhere() },
      });
      if (existing > 0) {
        already++;
        continue;
      }
      if (!preview) {
        setBusinessClock(e.businessAt);
        try {
          // No withScope here: emit() correlates the case itself, so an aggregate
          // the workflow moved into (an Order carrying its accountId, say) inherits
          // the case of the aggregate it references instead of starting a new one.
          // The row's FK columns are in e.payload (buildPayload keeps them), and
          // linearOrder guarantees the referenced parent's events are already
          // logged by the time we reach the child.
          await emit({
            ref: e.ref,
            aggregateId: e.aggregateId,
            role: e.role,
            payload: e.payload,
            ...(e.provenance ? { provenance: e.provenance } : {}),
            evidenceKind: plan.kind,
            evidence: e.evidence,
          });
        } finally {
          setBusinessClock(null);
        }
      }
      emitted++;
      totalEmitted++;
      touched.add(`${plan.aggregateRoot}:${e.aggregateId}`);
    }

    summaries.push({
      key: plan.key,
      name: plan.name,
      aggregateRoot: plan.aggregateRoot,
      kind: plan.kind,
      emitted,
      alreadyPresent: already,
      noEvidence: plan.noEvidence,
      sample,
    });
  }

  return { preview, totalEmitted, instances: touched.size, events: summaries };
}

/** Clear the active workflow's EventLog, then re-derive from the ingested rows
 * (which are left untouched). This is the workflow designer's "regenerate after a
 * model change": like deriveFromData() but without the idempotency floor, so a
 * changed model / changed evidence rule actually takes effect instead of being
 * skipped as already-present. Unlike genericDeleteAll() it does NOT clear the
 * gen_ projection rows — those ARE the source. Lossy by design: events that leave
 * no row trace (a login; see classify()'s "none") cannot be reconstructed. */
export async function rebuildFromData(opts: { limit?: number } = {}): Promise<DeriveResult> {
  const { count } = await prisma.eventLog.deleteMany({ where: eventLogOrgWhere() });
  const result = await deriveFromData({ preview: false, limit: opts.limit });
  return { ...result, cleared: count };
}
