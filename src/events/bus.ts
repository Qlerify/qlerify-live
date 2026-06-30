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

export async function emit(ev: EmittedEvent): Promise<void> {
  const def = findEvent(ev.ref);
  // The case this event belongs to: the simulator's explicit run scope when set,
  // otherwise model-driven correlation that links an aggregate the workflow moved
  // into back to the case its FK references (instead of starting a new case).
  const caseId = scopeOverride ?? (await correlateCaseId(def.aggregateRoot, ev.aggregateId, ev.payload));
  const provenance = ev.provenance ?? (await provenanceFor(def.boundedContext));

  await prisma.eventLog.create({
    data: {
      eventName: def.name,
      eventRef: def.ref,
      boundedContext: def.boundedContext,
      aggregateRoot: def.aggregateRoot,
      aggregateId: ev.aggregateId,
      caseId,
      role: ev.role,
      payload: JSON.stringify(ev.payload),
      businessAt: getBusinessClock() ?? businessDateFromPayload(def, ev.payload) ?? new Date(),
      provenance,
      evidenceKind: ev.evidenceKind ?? null,
      evidence: ev.evidence ?? null,
      // Multi-tenant spine: stamp the resolved org + workflow at the single
      // EventLog write chokepoint (system org/workflow for the demo + non-request
      // contexts). workflowId scopes the simulator's per-workflow data plane.
      organizationId: currentOrgId(),
      workflowId: currentWorkflowId(),
      // Governance attribution (src/platform/tenancy/actor.ts): WHO (the bound
      // principal, if any) + HOW (human/ai/system/adapter). Off-request emits have
      // no principal → null.
      actorPrincipalId: tenantContext()?.principal.id ?? null,
      actorKind: currentActorKind(),
    },
  });
}
