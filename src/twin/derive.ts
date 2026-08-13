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
//                     = those fields are set (a boolean field must be TRUE —
//                     false records the step not happening). Sibling events
//                     sharing one command (alternative outcomes of a decision)
//                     partition its fields by name affinity, each keeping its
//                     own flag (…GPR Approved ⇐ gprApproved).
//   • else          → no row-state evidence (e.g. a login that leaves no trace);
//                     skipped, with the reason recorded.
//
// It NEVER writes to the gen_ tables (the rows are already there) and is
// idempotent: an event already in the log for an aggregate id is not re-emitted,
// so a re-run only fills gaps and a synthetic simulator run is left untouched.
//
// The derived event carries the ROW's provenance (recorded/live/simulated) — a
// real ingested Account yields a real-looking AccountRegistered. The only thing
// "simulated" is the ordering/timing (businessAt), which is nominal — except a
// create event anchored to the connector's declared creation date, whose time IS
// witnessed. That split is stamped per event as businessAtKind known/estimated
// (see eventBaseDate) so the UI can show which timestamps to trust.
//
// SHAPE: planDerivation() is the PURE model-driven core (no DB, no I/O) — given
// an ontology and the rows per entity it returns exactly which events would fire
// and why. deriveFromData() is the thin I/O wrapper: read rows from the store,
// run the planner, skip events already in the log, and emit the rest.

import { prisma } from "../db.js";
import { emitMany, type BatchEvent } from "../events/bus.js";
import { getOntology, type Ontology, type OntologyEvent, type EntitySchema } from "../ontology/model.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { currentWorkflowId } from "../platform/tenancy/context.js";
import { withActorKind } from "../platform/tenancy/actor.js";
import { dateRolesForEntity } from "../packs/connector/orchestrate.js";
import { loadAuthoredRuleSet } from "../packs/connector/rules.js";
import { decideCaseId, foreignKeyFields, cycleLinkFields, subjectValues, type CycleLink } from "./correlate.js";
import { periodOf, periodStart, cycleId, periodKeyOf, type PeriodGranularity } from "./period.js";
import { PROV_MODES, type ProvMode } from "./provenance.js";
import * as store from "./projection-store.js";

// Platform / internal columns that are never business evidence and never part of
// a derived event's payload — the store's own list, minus `id` (which IS part of
// payloads and correlation). `_raw` (undeclared source fields folded to JSON at
// ingest) is visible to authored trigger rules via the full row, but never to
// the static heuristics or payloads.
const PLATFORM_COLS = new Set(store.PLATFORM_ROW_COLS.filter((c) => c !== "id"));

type EvidenceKind = "authored" | "create" | "status" | "fields" | "none";

// ---------------------------------------------------------------------------
// Authored trigger rules — the per-EVENT escape hatch from the static evidence
// heuristics below. A rule is a tiny pure predicate compiled (by AI, from the
// event's GWTs + the operator's condition) or hand-written per connector, loaded
// by packs/connector/rules.ts and INJECTED into planDerivation as plain
// functions, so the planner stays pure and unit-testable. A rule replaces only
// the firing predicate: payload + business-date semantics keep the event's
// static SHAPE kind (an authored create still rides FKs and seeds the ladder's
// first status; an authored status event still stamps its target status).
// ---------------------------------------------------------------------------

/** What a rule module's detect() must synchronously return. */
export interface AuthoredRuleResult {
  fired: boolean;
  /** Human-readable justification citing the deciding values. */
  evidence?: string;
}

/** The compiled predicate. `previous` is reserved for a future re-fire-on-change
 * contract — always null today, so rules written now survive that extension. */
export type AuthoredRuleFn = (
  row: Record<string, unknown>,
  ctx: RuleContext,
  previous: null,
) => AuthoredRuleResult;

/** What a rule may see. Deliberately closed: no network, no fs, no credentials —
 * a rule is a pure classification of workflow data (enforced by the deny-scan in
 * packs/connector/rules.ts; this type is the honest inventory). */
export interface RuleContext {
  event: { key: string; ref: string; name: string; acceptanceCriteria: string[] };
  entity: EntitySchema;
  /** Fixed once per derive pass — "current quarter" is stable across rows. */
  now: Date;
  period: {
    of: (date: Date, granularity: PeriodGranularity) => string;
    start: (period: string, granularity: PeriodGranularity) => Date | null;
  };
  /** Names of the workflow tables readTable can serve. */
  tables: string[];
  /** Read-only snapshot of another workflow table (case-insensitive name;
   * unknown table → []). Capped rows — a rule must not assume completeness. */
  readTable(name: string): Array<Record<string, unknown>>;
  log(msg: string): void;
}

/** The rules loaded for one derive pass, keyed by event key, plus the ctx
 * factory (built by packs/connector/rules.ts over the pass's row snapshots). */
export interface AuthoredRuleSet {
  rules: Map<string, { detect: AuthoredRuleFn; condition?: string; connectorId?: string }>;
  makeCtx(event: OntologyEvent, entity: EntitySchema): RuleContext;
  /** ctx.log lines accumulated this pass, keyed by event key. Lives on the set
   * (per-pass), never a module global, so concurrent passes don't cross-leak. */
  logs: Map<string, string[]>;
}

/** Rule health of one derive pass — surfaced, never silent (RuleReport rides on
 * DeriveResult so /sim/derive, pulls, and previews all show it). */
export interface RuleReport {
  /** Rules loaded and eligible to fire this pass. */
  active: number;
  /** Loaded rules whose source GWT drifted since compile — they still run;
   * drift is surfaced, never auto-applied. */
  stale: Array<{ eventKey: string; connector: string }>;
  /** Rules that failed to load/scan, or threw at evaluation (the event then
   * fell back to its static heuristic — see EventPlan.ruleError). */
  errors: Array<{ eventKey: string; connector: string; error: string }>;
  /** Rules skipped by design: operator-disabled, orphaned (event gone from the
   * model), or the connector kill-switch. */
  disabled: Array<{ eventKey: string; connector: string; reason: string }>;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function present(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

/** Presence counts as field evidence except for boolean columns, where only a
 * TRUTHY value does: an approval flag at false/0 records that the step did NOT
 * happen — the opposite of evidence. */
function fieldEvidence(entity: EntitySchema, name: string, v: unknown): boolean {
  if (!present(v)) return false;
  if (entity.fields.find((f) => f.name === name)?.dataType !== "boolean") return true;
  const s = String(v).trim().toLowerCase();
  return s !== "false" && s !== "0" && s !== "no";
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

/** Same-aggregate events bound to the SAME command as this one — alternative
 * OUTCOMES of one decision step ("Approval completed BR Approved" vs "… GPR
 * Approved" both firing UpdateStatus), not sequential steps. */
function commandSiblings(event: OntologyEvent, ont: Ontology): OntologyEvent[] {
  return ont.events.filter(
    (e) => e.key !== event.key && e.aggregateRoot === event.aggregateRoot && e.commandName === event.commandName,
  );
}

/** Entity-column fields this event's command INTRODUCES — present on its command,
 * a real column, and not already carried by any earlier same-aggregate event
 * (so a field shared with the create, like `email`, is not evidence for a later
 * event). This is what makes a login event — whose fields all came from register
 * — yield no distinguishing evidence.
 *
 * When SIBLING events share the command (alternative outcomes of one decision),
 * its fields are partitioned by name affinity — each outcome keeps the flag(s)
 * its own name embeds (…GPR Approved ↔ gprApproved) — so the first sibling in
 * linear order doesn't claim everything and leave the rest evidence-less. */
function distinguishingFields(event: OntologyEvent, entity: EntitySchema, ont: Ontology): string[] {
  const cmd = ont.command(event.commandName);
  if (!cmd) return [];
  const entityCols = new Set(entity.fields.map((f) => f.name));
  const order = ont.linearOrder();
  const myIdx = order.indexOf(event.key);
  const siblings = commandSiblings(event, ont);
  const siblingKeys = new Set(siblings.map((s) => s.key));
  const earlier = new Set<string>();
  for (let i = 0; i < order.length && i < myIdx; i++) {
    const e = ont.eventByKey(order[i]!);
    // A sibling is an alternative to this event, not a step before it — it must
    // not swallow the shared command's fields via the `earlier` set.
    if (!e || e.aggregateRoot !== event.aggregateRoot || siblingKeys.has(e.key)) continue;
    for (const f of ont.command(e.commandName)?.fields ?? []) earlier.add(f.name);
  }
  const claims = (e: OntologyEvent, field: string): boolean => norm(e.name + " " + e.key).includes(norm(field));
  return cmd.fields
    .map((f) => f.name)
    .filter((n) => n !== "id" && n !== "status" && entityCols.has(n) && !earlier.has(n))
    .filter((n) => {
      if (siblings.length === 0) return true;
      if (claims(event, n)) return true;
      if (siblings.some((s) => claims(s, n))) return false;
      // A field no outcome's name claims stays with the earliest sibling.
      return !siblings.some((s) => order.indexOf(s.key) < myIdx);
    });
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
      const missing = dist.filter((n) => !fieldEvidence(entity, n, row[n]));
      if (missing.length === 0) return { happened: true, reason: dist.map((n) => `${n}=${row[n]}`).join(", ") };
      return { happened: false, reason: `unset: ${missing.join(", ")}` };
    }
    default:
      return { happened: false, reason: "no row-state evidence (action leaves no trace on the aggregate)" };
  }
}

/** A nominal business date for the row's events: the first date-typed business
 * column with a parseable value, else the row's createdAt, else NULL — a row
 * with no usable source timestamp yields events with NO business time, never a
 * fabricated "now" (derivation time is not business time; unknown reads as
 * unknown). Dated events are then spread by their order index so an instance's
 * timeline stays monotonic. */
function rowBaseDate(row: Record<string, unknown>, entity: EntitySchema): Date | null {
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
  return null;
}

/** The real time anchor for ONE derived event on ONE row. A snapshot row records
 * at most two source anchors — creation and last-modified — and the connector's
 * declared date roles say which column is which:
 *   • create-kind event       → the source's CREATION date
 *   • status / fields (update) → the source's LAST-MODIFIED date, falling back to
 *                                creation
 * When no roles are declared (or the named column is empty/unparseable) it falls
 * back to rowBaseDate's model heuristic, so behaviour is unchanged for connectors
 * that set no roles. A row with no usable timestamp anywhere yields date NULL —
 * the event lands without a business time rather than pretending derivation time
 * is business time. The caller still adds the order-index offset to dated
 * anchors, which keeps multiple events sharing one anchor (two updates, or
 * create==update) ordered.
 *
 * `known` says whether that date is a WITNESSED time for this event, not just the
 * best estimate (meaningless when date is null). Only the create shape qualifies:
 * the source's creation date is by definition when the row (and so its create
 * event) came into being. An update event's time is always inferred — even a real
 * last-modified only bounds it (the row may have changed again since), and every
 * fallback is a heuristic. */
function eventBaseDate(
  kind: EvidenceKind,
  row: Record<string, unknown>,
  entity: EntitySchema,
  roles: { created?: string; updated?: string } | undefined,
): { date: Date | null; known: boolean } {
  const fromRole = (field?: string): Date | null => {
    if (!field || !present(row[field])) return null;
    const d = new Date(String(row[field]));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  if (roles) {
    if (kind === "create") {
      const d = fromRole(roles.created);
      if (d) return { date: d, known: true };
    } else if (kind === "status" || kind === "fields") {
      const d = fromRole(roles.updated) ?? fromRole(roles.created);
      if (d) return { date: d, known: false };
    }
  }
  return { date: rowBaseDate(row, entity), known: false };
}

function rowProvenance(row: Record<string, unknown>): ProvMode | undefined {
  const p = row._provenance;
  return typeof p === "string" && (PROV_MODES as readonly string[]).includes(p) ? (p as ProvMode) : undefined;
}

/** Fields carried by any LATER same-aggregate event's command (linear order) —
 * the counterpart of distinguishingFields' "earlier" set. */
function fieldsCarriedLater(event: OntologyEvent, ont: Ontology): Set<string> {
  const order = ont.linearOrder();
  const myIdx = order.indexOf(event.key);
  const later = new Set<string>();
  for (let i = myIdx + 1; i < order.length; i++) {
    const e = ont.eventByKey(order[i]!);
    if (!e || e.aggregateRoot !== event.aggregateRoot) continue;
    for (const f of ont.command(e.commandName)?.fields ?? []) later.add(f.name);
  }
  return later;
}

/** The derived event's payload — the fields ITS OWN command carries, mirroring
 * the command path (commands/base emitFor: the command's args + id + resulting
 * status), NOT the whole row. The detail view reconstructs "state as of step N"
 * by folding payloads in order, so an event carrying the full final row would
 * leak later steps' fields into earlier ones — and a later mutation of an
 * existing row would never read as a change. On top of the command's fields:
 *   • a create event also carries the FK columns no later command establishes
 *     (emit() correlates a child aggregate into its parent's case from the FKs
 *     in its first event's payload; an FK a later step sets rides on THAT
 *     step's payload instead, as one of its command fields),
 *   • status is the lifecycle value the event drives INTO (ladder target; the
 *     ladder's first value for a create) — the row's FINAL status would
 *     likewise leak the future into earlier steps. */
function buildPayload(
  kind: EvidenceKind,
  event: OntologyEvent,
  row: Record<string, unknown>,
  entity: EntitySchema,
  ont: Ontology,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entityCols = new Set(entity.fields.map((f) => f.name));
  const put = (name: string): void => {
    if (name === "id" || name === "status" || PLATFORM_COLS.has(name) || !entityCols.has(name)) return;
    if (row[name] !== undefined && row[name] !== null) out[name] = row[name];
  };
  for (const f of ont.command(event.commandName)?.fields ?? []) put(f.name);
  const ladder = statusLadder(entity);
  if (kind === "create") {
    const later = fieldsCarriedLater(event, ont);
    for (const fk of foreignKeyFields(entity.name, ont)) {
      if (!later.has(fk.name)) put(fk.name);
    }
    // Cycle subject FKs ride the create payload the same way (correlation reads
    // the subject key values off the child's first event).
    for (const link of cycleLinkFields(entity.name, ont)) {
      for (const pair of link.subjectFields) if (!later.has(pair.child)) put(pair.child);
    }
    if (ladder.length > 0) out.status = ladder[0];
  } else if (kind === "status") {
    const tgt = statusTargetIndex(event, entity);
    if (tgt >= 0) out.status = ladder[tgt];
  }
  out.id = String(row.id);
  return out;
}

/** One event the data implies happened for one aggregate instance — everything
 * emit() needs, plus the human-readable evidence. */
interface PlannedEmission {
  ref: string;
  aggregateId: string;
  role: string;
  payload: Record<string, unknown>;
  /** Null = no source timestamp anchors this event; it lands without a business
   * time (the moment is unknown — deliberately not faked to derivation time). */
  businessAt: Date | null;
  /** True when a source timestamp witnesses this event's time (see eventBaseDate);
   * false = businessAt is inferred and should read as an estimate. Irrelevant
   * when businessAt is null. */
  businessAtKnown: boolean;
  provenance?: ProvMode;
  evidence: string;
}

/** Per-event outcome of the plan: what fired, and how many rows held no evidence. */
interface EventPlan {
  key: string;
  name: string;
  aggregateRoot: string;
  kind: EvidenceKind;
  fired: PlannedEmission[];
  noEvidence: number;
  /** Set when this event's authored rule threw or returned a malformed result —
   * the whole event was re-evaluated with its static heuristic (kind reflects
   * that fallback), never a silent per-row mix of authored and static. */
  ruleError?: string;
}

/** PURE model-driven core: given the ontology and the rows per entity, decide
 * which events the data implies. No DB, no I/O, no idempotency — that's the
 * wrapper's job. Walks events in linear order so an instance's create precedes
 * its updates (and the businessAt spread stays monotonic). An AuthoredRuleSet
 * (pre-loaded by the wrapper) overrides the firing predicate per event; absent,
 * every event runs the static heuristics unchanged. */
export function planDerivation(
  ont: Ontology,
  rowsByEntity: Map<string, Array<Record<string, unknown>>>,
  dateRolesByEntity?: Map<string, { created?: string; updated?: string }>,
  authored?: AuthoredRuleSet,
): EventPlan[] {
  const order = ont.linearOrder();
  const plans: EventPlan[] = [];
  // Aggregate ids each event fired for, so a root-less satellite can mirror the
  // predecessor it's coupled to (it has no independent evidence rule of its own).
  const firedIdsByEvent = new Map<string, Set<string>>();

  for (let oi = 0; oi < order.length; oi++) {
    const event = ont.eventByKey(order[oi]!);
    if (!event) continue;
    if (!event.commandName) continue; // inert marker: shown in the flow, not derived from data
    const entity = ont.entity(event.aggregateRoot);
    if (!entity) continue;
    const rows = rowsByEntity.get(entity.name) ?? [];
    if (rows.length === 0) continue;
    const roles = dateRolesByEntity?.get(entity.name);

    // The static shape kind ALWAYS drives payload + business-date semantics; an
    // authored rule replaces only the firing predicate. Satellites keep their
    // mirror-the-predecessor semantics — a rule never binds to a coupled event.
    const shapeKind = classify(event, entity, ont);
    const entry = !event.coupledTo ? authored?.rules.get(event.key) : undefined;

    // A satellite "completes with" its coupled predecessor: fire for exactly the
    // rows where that predecessor fired, not its own (absent) evidence rule.
    const predFired = event.coupledTo ? firedIdsByEvent.get(event.coupledTo) ?? new Set<string>() : null;
    const coupledName = event.coupledTo ? ont.eventByKey(event.coupledTo)?.name ?? event.coupledTo : "";

    /** One pass over the rows — with the authored predicate, or the static one.
     * Throws on a broken rule so the caller can rerun the WHOLE event statically. */
    const runPass = (rule: typeof entry): { fired: PlannedEmission[]; firedIds: Set<string>; noEvidence: number } => {
      const ctx = rule ? authored!.makeCtx(event, entity) : null;
      const fired: PlannedEmission[] = [];
      const firedIds = new Set<string>();
      let noEvidence = 0;
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (!id) continue;
        let reason: string;
        if (predFired) {
          if (!predFired.has(id)) {
            noEvidence++;
            continue;
          }
          reason = `completes with ${coupledName}`;
        } else if (rule) {
          // A SHALLOW COPY, never the planner's own row object: a rule that
          // mutates its argument (AI code plausibly normalizes in place, e.g.
          // `row.status = String(row.status).toUpperCase()`) would otherwise
          // corrupt this event's own payload, every LATER event's evaluation of
          // the same shared row, and the cycle indexes built from rowsByEntity.
          const r = rule.detect({ ...row }, ctx!, null) as AuthoredRuleResult | undefined;
          if (!r || typeof r.fired !== "boolean") {
            // Also catches an async detect: a Promise has no boolean `fired`.
            throw new Error("detect(row, ctx) must synchronously return { fired: boolean, evidence?: string }");
          }
          if (!r.fired) {
            noEvidence++;
            continue;
          }
          reason = `rule: ${typeof r.evidence === "string" && r.evidence ? r.evidence : "condition met"}`;
        } else {
          const ev = evaluate(shapeKind, event, row, entity, ont);
          if (!ev.happened) {
            noEvidence++;
            continue;
          }
          reason = ev.reason;
        }
        const base = eventBaseDate(shapeKind, row, entity, roles);
        fired.push({
          ref: event.ref,
          aggregateId: id,
          role: event.role,
          payload: buildPayload(shapeKind, event, row, entity, ont),
          businessAt: base.date ? new Date(base.date.getTime() + oi * 1000) : null,
          businessAtKnown: base.known,
          provenance: rowProvenance(row),
          evidence: reason,
        });
        firedIds.add(id);
      }
      return { fired, firedIds, noEvidence };
    };

    let pass: ReturnType<typeof runPass>;
    let ruleError: string | undefined;
    if (entry) {
      try {
        pass = runPass(entry);
      } catch (e: any) {
        // Fail soft AND visible: the partial authored results are discarded, the
        // event re-derives with its static heuristic, and the error is recorded
        // on the plan → DeriveResult.rules.errors. The ingest wrapper journals it
        // onto the connector's history, and /sim/derive + preview surface it —
        // never a silent skip.
        ruleError = String(e?.message ?? e).slice(0, 300);
        pass = runPass(undefined);
      }
    } else {
      pass = runPass(undefined);
    }
    const kind: EvidenceKind = entry && !ruleError ? "authored" : shapeKind;

    firedIdsByEvent.set(event.key, pass.firedIds);
    plans.push({
      key: event.key,
      name: event.name,
      aggregateRoot: event.aggregateRoot,
      kind,
      fired: pass.fired,
      noEvidence: pass.noEvidence,
      ...(ruleError ? { ruleError } : {}),
    });
  }

  return plans;
}

interface DerivedEventSummary {
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
  /** Preview mode only: the first fired rows with their evidence, so a rule (or
   * heuristic) can be inspected against real data before anything is emitted. */
  samples?: Array<{ id: string; evidence: string }>;
  /** The event's authored rule broke and the static heuristic answered instead
   * (see EventPlan.ruleError). */
  ruleError?: string;
}

/** Cycle-correlation outcome of one derive pass — the diagnostics that make an
 * AI-built connector's mistakes visible instead of silently orphaning events. */
interface CycleReport {
  /** Cycle rows the engine opened lazily (a child's period had no row yet). */
  opened: number;
  /** Child events with a cycle subject key but NO business date — their period
   * is uncomputable, so they could not join a cycle. Points at dateRoles. */
  noBusinessDate: number;
  /** Subject key values matching NO cycle row of any period — shape drift
   * between the parent and child connectors (e.g. "hubspot-company-X" vs "X"). */
  unknownSubjects: Array<{ target: string; value: string; events: number }>;
}

interface DeriveResult {
  preview: boolean;
  totalEmitted: number;
  /** Distinct aggregate instances that gained at least one event. */
  instances: number;
  events: DerivedEventSummary[];
  /** Cycle-correlation outcome; only present when the model declares a
   * period-scoped aggregate. */
  cycles?: CycleReport;
  /** Authored trigger-rule health; only present when the workflow's connectors
   * carry rules (or tried to — errors and disabled rules surface here too). */
  rules?: RuleReport;
  /** Preview only: ctx.log lines per event key from this pass's authored rules
   * (carried off the rule set, never a module global — no cross-pass leak). */
  ruleLogs?: Record<string, string[]>;
  /** Wall-clock ms the derivation pass took. */
  durationMs: number;
  /** Event-log rows deleted before re-deriving. Only set by rebuildFromData(). */
  cleared?: number;
}

/** The idempotency key: this event already fired for this aggregate instance. */
const pairKey = (eventRef: string, aggregateId: string): string => `${eventRef}\u0000${aggregateId}`;

// Serialize EMITTING derive passes per workflow. The idempotency floor is a
// read-then-write over the EventLog (seed `seen` from findMany, later emitMany):
// two overlapping passes for one workflow both read before either writes, both
// plan the same not-yet-logged events, and both emit them — duplicates, since
// emitMany is a plain createMany with no unique constraint. ingest's inFlight
// guard is PER-ADAPTER, so two adapters in one workflow (a scheduled pull of X
// auto-deriving while a manual pull of Y derives) race here. A per-workflow
// promise chain makes emitting passes run one at a time; preview passes never
// emit, so they skip the chain (and stay concurrent).
const deriveChains = new Map<string, Promise<unknown>>();

export function deriveFromData(opts: { preview?: boolean; limit?: number | null } = {}): Promise<DeriveResult> {
  if (opts.preview) return runDerive(opts);
  let wf: string;
  try { wf = currentWorkflowId(); } catch { return runDerive(opts); } // off-context (tests/boot): no scope to serialize on
  const prior = deriveChains.get(wf) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => runDerive(opts));
  // Keep the chain tip current, and prune it once settled so the map doesn't grow.
  deriveChains.set(wf, next);
  next.finally(() => { if (deriveChains.get(wf) === next) deriveChains.delete(wf); }).catch(() => {});
  return next;
}

/** I/O wrapper: read the ingested rows from the store, plan the derivation, skip
 * events already in the log, and emit the rest. `preview: true` runs the plan and
 * the already-present check without emitting — the UI uses it to show what would
 * fire. Idempotent.
 *
 * Batched for scale: `limit` defaults to ALL rows (pass a number to window), and
 * the whole pass costs a fixed handful of queries instead of three per event —
 * ONE read of the workflow's log seeds both the idempotency set and the
 * instance→case map, correlation then runs in memory through the same pure
 * decideCaseId the emit() path uses, and the new events land via emitMany()'s
 * chunked INSERTs. planDerivation's linear order still guarantees a referenced
 * parent's create is decided before the child that inherits its case. */
async function runDerive(opts: { preview?: boolean; limit?: number | null } = {}): Promise<DeriveResult> {
  const t0 = Date.now();
  const preview = !!opts.preview;
  const limit = opts.limit ?? null;
  const ont = getOntology();

  // Load the rows for every aggregate root that some event targets, plus that
  // table's connector-declared timestamp roles (so create/update events get the
  // source's real creation/last-modified dates instead of ingestion-time `now`).
  const rowsByEntity = new Map<string, Array<Record<string, unknown>>>();
  const dateRolesByEntity = new Map<string, { created?: string; updated?: string }>();
  for (const name of new Set(ont.events.map((e) => e.aggregateRoot))) {
    if (rowsByEntity.has(name)) continue;
    rowsByEntity.set(name, (await store.tableExists(name)) ? await store.findMany(name, limit) : []);
    const roles = dateRolesForEntity(name);
    if (roles) dateRolesByEntity.set(name, roles);
  }

  // Authored trigger rules for this workflow's connectors (empty set + report
  // when there are none / off-context / kill-switched) — loaded HERE, alongside
  // the rows, so the planner itself stays pure and synchronous.
  const { set: authoredRules, report: ruleReport } = await loadAuthoredRuleSet(ont, rowsByEntity);

  const plans = planDerivation(ont, rowsByEntity, dateRolesByEntity, authoredRules);

  // A rule that broke during planning fell back to the static heuristic — fold
  // it into the report so every derive surface shows it.
  for (const plan of plans) {
    if (plan.ruleError) {
      ruleReport.errors.push({
        eventKey: plan.key,
        connector: authoredRules?.rules.get(plan.key)?.connectorId ?? "",
        error: plan.ruleError,
      });
    }
  }

  // ONE tenant-scoped pass over the log replaces the per-event queries: every
  // (eventRef, aggregateId) pair already present (idempotency), and the case each
  // instance is already attached to (correlation seed — earliest event wins, the
  // same rule correlateCaseId's orderBy encodes).
  const seen = new Set<string>();
  const caseByInstance = new Map<string, string>();
  for (const r of await prisma.eventLog.findMany({
    where: eventLogOrgWhere(),
    orderBy: { occurredAt: "asc" },
    select: { eventRef: true, aggregateId: true, caseId: true },
  })) {
    seen.add(pairKey(r.eventRef, r.aggregateId));
    if (r.aggregateId && r.caseId && !caseByInstance.has(r.aggregateId)) caseByInstance.set(r.aggregateId, r.caseId);
  }

  const summaries: DerivedEventSummary[] = [];
  const touched = new Set<string>();
  const batch: BatchEvent[] = [];
  let totalEmitted = 0;

  // --- Cycle support (period-scoped aggregates, twin/period.ts) --------------
  // In-memory indexes over each period-scoped entity's rows, matching on the
  // subject + period COLUMN VALUES (never id shape, so legacy row ids resolve):
  //   coord (subject values + period) → row  — cycle resolution for decideCaseId
  //   subject values → latest row            — the template a lazy open copies
  // Keys are lowercased to match the live path's case-insensitive store filters.
  const coordKey = (values: string[], period: string): string =>
    [...values, period].map((v) => v.toLowerCase()).join("\u0000");
  const subjKey = (values: string[]): string => values.map((v) => v.toLowerCase()).join("\u0000");
  const cycleRows = new Map<string, Map<string, Record<string, unknown>>>();
  const cycleTemplates = new Map<string, Map<string, Record<string, unknown>>>();
  const periodScoped = ont.entities.filter((e) => periodKeyOf(e) !== null);
  for (const entity of periodScoped) {
    const pk = periodKeyOf(entity)!;
    const byCoord = new Map<string, Record<string, unknown>>();
    const bySubject = new Map<string, Record<string, unknown>>();
    for (const row of rowsByEntity.get(entity.name) ?? []) {
      const values = pk.subjectFields.map((f) => String(row[f] ?? ""));
      const period = String(row[pk.periodField] ?? "");
      if (values.some((v) => !v.trim()) || !period.trim()) continue;
      byCoord.set(coordKey(values, period), row);
      // Latest period wins as the template (canonical period formats sort
      // lexicographically within a granularity).
      const prev = bySubject.get(subjKey(values));
      if (!prev || String(prev[pk.periodField] ?? "") < period) bySubject.set(subjKey(values), row);
    }
    cycleRows.set(entity.name, byCoord);
    cycleTemplates.set(entity.name, bySubject);
  }
  const cycleReport: CycleReport = { opened: 0, noBusinessDate: 0, unknownSubjects: [] };
  const unknownSubjectCounts = new Map<string, { target: string; value: string; events: number }>();

  /** Lazily open the cycle row a child's (subject, period) coordinates name —
   * the data-driven "time-triggered event". Only for a KNOWN subject (some row
   * of any period carries these exact values): an unknown subject is far more
   * likely connector value-shape drift than a real new cycle, so it is reported
   * instead of materialized. The new row copies the template's fields, gets the
   * engine-composed canonical id, and is marked _provisional so the connector's
   * next pull enriches it (packs/ingest.ts merges into provisional rows). Its
   * create event is emitted at the period's start, estimated. */
  const ensureCycleRow = async (link: CycleLink, values: string[], period: string, childEventName: string): Promise<void> => {
    const byCoord = cycleRows.get(link.target);
    if (!byCoord || byCoord.has(coordKey(values, period))) return;
    const template = cycleTemplates.get(link.target)?.get(subjKey(values));
    if (!template) {
      const k = `${link.target}\u0000${values.join(", ")}`;
      const cur = unknownSubjectCounts.get(k);
      if (cur) cur.events++;
      else unknownSubjectCounts.set(k, { target: link.target, value: values.join(", "), events: 1 });
      return;
    }
    const entity = ont.entity(link.target);
    if (!entity) return;
    const rowId = cycleId(values, period);
    const row: Record<string, unknown> = {};
    for (const f of entity.fields) {
      if (f.name === "id" || PLATFORM_COLS.has(f.name)) continue;
      if (template[f.name] !== undefined) row[f.name] = template[f.name];
    }
    row.id = rowId;
    row[link.periodField] = period;
    row._provenance = template._provenance ?? null;
    row._provisional = 1;
    // No fabricated timestamps: the row wasn't pulled from a source (see
    // packs/ingest.ts) — it exists because the period does.
    row.createdAt = null;
    row.updatedAt = null;
    await store.ensureColumn(link.target, "_provisional", "INTEGER");
    await store.insert(link.target, row);
    byCoord.set(coordKey(values, period), row);
    const prevTemplate = cycleTemplates.get(link.target)?.get(subjKey(values));
    if (!prevTemplate || String(prevTemplate[link.periodField] ?? "") < period) {
      cycleTemplates.get(link.target)?.set(subjKey(values), row);
    }
    cycleReport.opened++;
    // The cycle's create event, so the new case has an honest start-of-period
    // anchor. A model whose cycle entity has no create event still gets the row.
    const createEvent = ont.events.find(
      (ev) => ev.aggregateRoot === link.target && ev.commandName && isCreateEvent(ev, ont),
    );
    if (!createEvent || seen.has(pairKey(createEvent.ref, rowId))) return;
    seen.add(pairKey(createEvent.ref, rowId));
    caseByInstance.set(rowId, rowId);
    batch.push({
      ref: createEvent.ref,
      aggregateId: rowId,
      role: createEvent.role,
      payload: buildPayload("create", createEvent, row, entity, ont),
      provenance: rowProvenance(row),
      evidenceKind: "create",
      evidence: `cycle ${period} opened by ${childEventName}`,
      businessAt: periodStart(period, link.granularity),
      businessAtKind: "estimated",
      caseId: rowId,
    });
    totalEmitted++;
    touched.add(`${link.target}:${rowId}`);
  };

  for (const plan of plans) {
    let emitted = 0;
    let already = 0;
    const sample: string | undefined = plan.fired[0]?.evidence;
    const links = cycleLinkFields(plan.aggregateRoot, ont);

    for (const e of plan.fired) {
      if (seen.has(pairKey(e.ref, e.aggregateId))) {
        already++;
        continue;
      }
      seen.add(pairKey(e.ref, e.aggregateId));
      // A child of a cycle whose period has no row yet opens it here (the
      // data-driven time trigger) BEFORE correlation, so the resolver below
      // finds it. Preview must not write; a dateless child can't be bucketed
      // into a period at all — reported, not guessed.
      if (links.length > 0) {
        if (!e.businessAt) {
          if (links.some((l) => subjectValues(l, e.payload))) cycleReport.noBusinessDate++;
        } else if (!preview) {
          for (const link of links) {
            const values = subjectValues(link, e.payload);
            if (values) await ensureCycleRow(link, values, periodOf(e.businessAt, link.granularity), plan.name);
          }
        }
      }
      // No withScope here: the case is correlated per event, so an aggregate the
      // workflow moved into (an Order carrying its accountId, say) inherits the
      // case of the aggregate it references instead of starting a new one. The
      // row's FK columns ride on its create event's payload (buildPayload keeps
      // them there), and the plans' linear order guarantees the referenced
      // parent's case is in the map by the time we reach the child.
      const caseId = decideCaseId(ont, plan.aggregateRoot, e.aggregateId, e.payload, (id) => caseByInstance.get(id) ?? null, {
        businessAt: e.businessAt,
        cycleCase: (link, values, period) => {
          const row = cycleRows.get(link.target)?.get(coordKey(values, period));
          if (row?.id == null) return null;
          const rowId = String(row.id);
          return caseByInstance.get(rowId) ?? rowId;
        },
      });
      if (caseId && !caseByInstance.has(e.aggregateId)) caseByInstance.set(e.aggregateId, caseId);
      if (!preview) {
        batch.push({
          ref: e.ref,
          aggregateId: e.aggregateId,
          role: e.role,
          payload: e.payload,
          ...(e.provenance ? { provenance: e.provenance } : {}),
          evidenceKind: plan.kind,
          evidence: e.evidence,
          businessAt: e.businessAt,
          // No business time → no trust qualifier either; the null pair reads
          // as "moment unknown", distinct from simulator/live rows (businessAt
          // set, kind null).
          ...(e.businessAt ? { businessAtKind: (e.businessAtKnown ? "known" : "estimated") as "known" | "estimated" } : {}),
          caseId,
        });
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
      ...(preview ? { samples: plan.fired.slice(0, 5).map((f) => ({ id: f.aggregateId, evidence: f.evidence })) } : {}),
      ...(plan.ruleError ? { ruleError: plan.ruleError } : {}),
    });
  }

  // Derived facts come from ingested source data, not a person or the assistant —
  // attribute them to the adapter origin.
  if (batch.length > 0) await withActorKind("adapter", () => emitMany(batch));

  cycleReport.unknownSubjects = [...unknownSubjectCounts.values()].slice(0, 20);
  const rulesRelevant =
    ruleReport.active > 0 || ruleReport.errors.length > 0 || ruleReport.stale.length > 0 || ruleReport.disabled.length > 0;
  return {
    preview,
    totalEmitted,
    instances: touched.size,
    events: summaries,
    ...(periodScoped.length > 0 ? { cycles: cycleReport } : {}),
    ...(rulesRelevant ? { rules: ruleReport } : {}),
    // Preview carries the rules' ctx.log lines back for the editor's oracle view;
    // an emitting pass has no reader for them (and would just bloat the payload).
    ...(preview && authoredRules && authoredRules.logs.size
      ? { ruleLogs: Object.fromEntries([...authoredRules.logs].filter(([, v]) => v.length)) }
      : {}),
    durationMs: Date.now() - t0,
  };
}

/** Clear the active workflow's EventLog, then re-derive from the ingested rows
 * (which are left untouched). This is the workflow designer's "regenerate after a
 * model change": like deriveFromData() but without the idempotency floor, so a
 * changed model / changed evidence rule actually takes effect instead of being
 * skipped as already-present. Unlike genericDeleteAll() it does NOT clear the
 * gen_ projection rows — those ARE the source. Lossy by design: events that leave
 * no row trace (a login; see classify()'s "none") cannot be reconstructed. */
export async function rebuildFromData(opts: { limit?: number | null } = {}): Promise<DeriveResult> {
  const { count } = await prisma.eventLog.deleteMany({ where: eventLogOrgWhere() });
  const result = await deriveFromData({ preview: false, limit: opts.limit });
  return { ...result, cleared: count };
}
