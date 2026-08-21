// In-process event bus. Each command handler emits its event after the
// aggregate write commits, persisting it to EventLog. The "case" an event is
// grouped under is pinned via withScope() during a simulator run.

import { prisma } from "../db.js";
import { findEvent, type EventDef } from "./registry.js";
import { getBusinessClock } from "./clock.js";
import { getOntology } from "../ontology/model.js";
import { provenanceFor, type ProvMode } from "../twin/provenance.js";
import { currentOrgId, currentWorkflowId, tenantContext } from "../platform/tenancy/context.js";
import { currentActorKind } from "../platform/tenancy/actor.js";
import { invalidateReads } from "../platform/read-cache.js";
import { correlateCaseId } from "../twin/correlate.js";
import type { Role } from "../auth.js";

export interface EmittedEvent {
  ref: string;             // e.g. "#/domainEvents/LeadCaptured"
  aggregateId: string;
  role: Role;
  payload: Record<string, unknown>;
  // Where this fact came from. Adapters set it explicitly (recorded/live);
  // omitted → defaults to the emitting bounded context's configured mode
  // (`simulated` until an adapter claims the BC). See twin/provenance.ts.
  provenance?: ProvMode;
  // Why this event fired, when it was derived from ingested data (twin/derive.ts):
  // the scenario (create/status/fields/none) and a human-readable reason. Omitted
  // for synthetic/simulator-stepped events, which have no row-state evidence.
  evidenceKind?: string;
  evidence?: string;
  // How trustworthy businessAt is: "known" (a source timestamp directly anchors
  // this event) or "estimated" (inferred — ordering right, moment nominal).
  // Omitted for simulator/live events, whose time needs no qualifier.
  businessAtKind?: "known" | "estimated";
}

// Scope override: the generic simulator runs every command of one "run" with the
// run's root-instance id set here, so emitted events are grouped by that id
// (written to EventLog.caseId). null → fall back to model-driven case correlation
// (twin/correlate.ts), which links an aggregate to the case its FK references.
let scopeOverride: string | null = null;
/** Run `fn` with the event scope pinned to `id`, restoring the prior scope after. */
export async function withScope<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = scopeOverride;
  scopeOverride = id;
  try {
    return await fn();
  } finally {
    scopeOverride = prev;
  }
}

// businessAt resolution ------------------------------------------------------
// The event's business date follows the data: it comes from a date attribute
// carried in the event's own payload (the command/source record), so the
// timeline's per-step durations are simply the difference between consecutive
// events' dates — nothing is hard-coded to a particular model. We consult the
// model's field metadata (command args + entity columns) for a date-typed or
// date-named field whose payload value parses to a real Date, preferring an
// explicit occurrence-style attribute. Caller override wins; no date at all →
// the real recorded time (resolved at the call site).

const DATE_NAME_RE = /(date|time|timestamp|occurr|deadline|eta)/i;
const OCCURRENCE_NAME_RE = /(occurr|eventdate|event_date|happened|recorded|timestamp)/i;

function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function businessDateFromPayload(def: EventDef, payload: Record<string, unknown>): Date | null {
  let ont: ReturnType<typeof getOntology>;
  try { ont = getOntology(); } catch { return null; }
  const event = ont.eventByRef(def.ref);
  const command = event ? ont.command(event.commandName) : undefined;
  const entity = ont.entity(def.aggregateRoot);

  // Score each model field the payload carries: an explicit occurrence-style
  // name beats a date dataType beats a merely date-ish name.
  const scored: Array<{ name: string; score: number }> = [];
  const seen = new Set<string>();
  for (const f of [...(command?.fields ?? []), ...(entity?.fields ?? [])]) {
    if (seen.has(f.name) || !(f.name in payload)) continue;
    seen.add(f.name);
    const isDateType = /date|time/i.test(f.dataType ?? "");
    if (!isDateType && !DATE_NAME_RE.test(f.name)) continue;
    let score = isDateType ? 2 : 1;
    if (OCCURRENCE_NAME_RE.test(f.name)) score += 2;
    scored.push({ name: f.name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  for (const { name } of scored) {
    const d = toDate(payload[name]);
    if (d) return d;
  }

  // Adapter-shaped rows whose columns aren't declared in the model: accept any
  // date-ish payload key as a last resort.
  for (const [k, v] of Object.entries(payload)) {
    if (seen.has(k) || !DATE_NAME_RE.test(k)) continue;
    const d = toDate(v);
    if (d) return d;
  }
  return null;
}

/** The EventLog row for one event — the single stamping chokepoint shared by
 * emit() and emitMany(), so batched writes carry exactly the same columns:
 *   • Multi-tenant spine: the resolved org + workflow (system org/workflow for
 *     the demo + non-request contexts). workflowId scopes the simulator's
 *     per-workflow data plane.
 *   • Governance attribution (src/platform/tenancy/actor.ts): WHO (the bound
 *     principal, if any) + HOW (human/ai/system/adapter). Off-request emits have
 *     no principal → null.
 * `occurredAt` is omitted on the single-emit path (DB default: now); the batch
 * path stamps it explicitly to keep intra-batch order deterministic. */
function eventRow(
  ev: EmittedEvent,
  def: EventDef,
  caseId: string | null,
  provenance: ProvMode,
  businessAt: Date | null,
  occurredAt?: Date,
) {
  return {
    eventName: def.name,
    eventRef: def.ref,
    boundedContext: def.boundedContext,
    aggregateRoot: def.aggregateRoot,
    aggregateId: ev.aggregateId,
    caseId,
    role: ev.role,
    payload: JSON.stringify(ev.payload),
    ...(occurredAt ? { occurredAt } : {}),
    businessAt,
    businessAtKind: ev.businessAtKind ?? null,
    provenance,
    evidenceKind: ev.evidenceKind ?? null,
    evidence: ev.evidence ?? null,
    organizationId: currentOrgId(),
    workflowId: currentWorkflowId(),
    actorPrincipalId: tenantContext()?.principal.id ?? null,
    actorKind: currentActorKind(),
  };
}

export async function emit(ev: EmittedEvent): Promise<void> {
  const def = findEvent(ev.ref);
  // Business time resolves BEFORE the case: cycle correlation buckets it into a
  // period (quarterOf(scheduledAt) → which Quarter case this event belongs to).
  const businessAt = getBusinessClock() ?? businessDateFromPayload(def, ev.payload) ?? new Date();
  // The case this event belongs to: the simulator's explicit run scope when set,
  // otherwise model-driven correlation that links an aggregate the workflow moved
  // into back to the case its FK references (instead of starting a new case).
  const caseId = scopeOverride ?? (await correlateCaseId(def.aggregateRoot, ev.aggregateId, ev.payload, businessAt));
  const provenance = ev.provenance ?? (await provenanceFor(def.boundedContext));
  const row = eventRow(ev, def, caseId, provenance, businessAt);
  await prisma.eventLog.create({ data: row });
  invalidateReads(row.organizationId, row.workflowId);
}

/** An event for the batch path, with the two per-event decisions emit() makes
 * from context/DB already resolved by the caller: the business time (the
 * derivation planned it; null = no source timestamp anchors it — the moment is
 * unknown and deliberately NOT faked to derivation time) and the case
 * (correlated in memory — see twin/derive.ts). */
export interface BatchEvent extends EmittedEvent {
  businessAt: Date | null;
  caseId: string | null;
}

// SQLite bind-variable budget: ~19 columns per EventLog row must stay under the
// engine's variable cap (999 on conservative builds), so 50 rows per INSERT.
const EMIT_CHUNK = 50;

/** Batch counterpart of emit() for bulk derivation: identical stamping (same
 * eventRow chokepoint, same tenant/actor context), but ONE chunked multi-row
 * INSERT per EMIT_CHUNK events instead of a round trip per event — this is what
 * lets a derive over tens of thousands of rows finish in seconds. occurredAt is
 * stamped explicitly, strictly increasing and ending at "now", so recorded order
 * (every reader sorts by occurredAt) stays deterministic within a batch. */
export async function emitMany(evs: BatchEvent[]): Promise<void> {
  if (evs.length === 0) return;
  const provByBc = new Map<string, ProvMode>();
  const base = Date.now() - evs.length;
  const rows = [];
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i]!;
    const def = findEvent(ev.ref);
    let provenance = ev.provenance ?? provByBc.get(def.boundedContext);
    if (!provenance) {
      provenance = await provenanceFor(def.boundedContext);
      provByBc.set(def.boundedContext, provenance);
    }
    rows.push(eventRow(ev, def, ev.caseId, provenance, ev.businessAt, new Date(base + i)));
  }
  for (let i = 0; i < rows.length; i += EMIT_CHUNK) {
    await prisma.eventLog.createMany({ data: rows.slice(i, i + EMIT_CHUNK) });
  }
  invalidateReads(rows[0]!.organizationId, rows[0]!.workflowId);
}
