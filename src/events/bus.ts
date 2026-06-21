// In-process event bus. Each command handler emits its event after the
// aggregate write commits. Subscribers run synchronously on the same tick;
// derived events subscribe to upstream events and emit their own.

import { prisma } from "../db.js";
import { findEvent, type EventDef } from "./registry.js";
import { getBusinessClock } from "./clock.js";
import { getOntology } from "../ontology/model.js";
import { provenanceFor, type ProvMode } from "../twin/provenance.js";
import { currentOrgId, currentProjectId } from "../platform/tenancy/context.js";
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
}

// Walks the aggregate graph from any root → owning Demand.
// Used to scope event-log entries to a demand so the multi-demand dashboard
// can show per-demand progress without joining at read time.
async function resolveDemandId(aggregateRoot: string, aggregateId: string, payload: Record<string, unknown>): Promise<string | null> {
  if (!aggregateId) {
    // Some events (Create*) emit before the aggregate's id is in the payload's fk; fall back to payload.demandId / projectId.
    if (typeof payload.demandId === "string") return payload.demandId;
    return null;
  }
  switch (aggregateRoot) {
    case "Demand":
      return aggregateId;
    case "Project": {
      const p = await prisma.project.findUnique({ where: { id: aggregateId }, select: { demandId: true } });
      return p?.demandId ?? null;
    }
    case "EngineeringRelease": {
      const er = await prisma.engineeringRelease.findUnique({ where: { id: aggregateId }, select: { projectId: true } });
      if (!er) return null;
      const p = await prisma.project.findUnique({ where: { id: er.projectId }, select: { demandId: true } });
      return p?.demandId ?? null;
    }
    case "EngineeringChange": {
      const ec = await prisma.engineeringChange.findUnique({ where: { id: aggregateId }, select: { projectId: true } });
      if (!ec) return null;
      const p = await prisma.project.findUnique({ where: { id: ec.projectId }, select: { demandId: true } });
      return p?.demandId ?? null;
    }
    case "BuildPlan": {
      const bp = await prisma.buildPlan.findUnique({ where: { id: aggregateId }, select: { demandId: true } });
      return bp?.demandId ?? null;
    }
    case "Build": {
      const b = await prisma.build.findUnique({
        where: { id: aggregateId },
        select: { buildPlan: { select: { demandId: true } } },
      });
      return b?.buildPlan.demandId ?? null;
    }
    case "PurchaseOrder": {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: aggregateId }, select: { projectId: true } });
      if (!po) return null;
      const p = await prisma.project.findUnique({ where: { id: po.projectId }, select: { demandId: true } });
      return p?.demandId ?? null;
    }
    case "LineBooking": {
      const lb = await prisma.lineBooking.findUnique({ where: { id: aggregateId }, select: { buildId: true } });
      if (!lb) return null;
      const b = await prisma.build.findUnique({
        where: { id: lb.buildId },
        select: { buildPlan: { select: { demandId: true } } },
      });
      return b?.buildPlan.demandId ?? null;
    }
    case "TestResult": {
      const tr = await prisma.testResult.findUnique({ where: { id: aggregateId }, select: { buildId: true } });
      if (!tr) return null;
      const b = await prisma.build.findUnique({
        where: { id: tr.buildId },
        select: { buildPlan: { select: { demandId: true } } },
      });
      return b?.buildPlan.demandId ?? null;
    }
    case "Shipment": {
      const s = await prisma.shipment.findUnique({ where: { id: aggregateId }, select: { demandId: true } });
      return s?.demandId ?? null;
    }
    default:
      return null;
  }
}

type Subscriber = (ev: EmittedEvent) => Promise<void> | void;

const subscribers = new Map<string, Subscriber[]>();
const wildcardSubscribers: Subscriber[] = [];

// Scope override: the generic simulator runs every command of one "run" with the
// run's root-instance id set here, so emitted events are grouped by that id
// (written to EventLog.demandId) without depending on the Ericsson-only
// resolveDemandId aggregate-walk. null → fall back to resolveDemandId.
let scopeOverride: string | null = null;
export function setScopeOverride(id: string | null): void {
  scopeOverride = id;
}
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

export function subscribe(ref: string, fn: Subscriber) {
  const list = subscribers.get(ref) ?? [];
  list.push(fn);
  subscribers.set(ref, list);
}

export function subscribeAll(fn: Subscriber) {
  wildcardSubscribers.push(fn);
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
  const demandId = scopeOverride ?? (await resolveDemandId(def.aggregateRoot, ev.aggregateId, ev.payload));
  const provenance = ev.provenance ?? (await provenanceFor(def.boundedContext));

  await prisma.eventLog.create({
    data: {
      eventName: def.name,
      eventRef: def.ref,
      boundedContext: def.boundedContext,
      aggregateRoot: def.aggregateRoot,
      aggregateId: ev.aggregateId,
      demandId,
      role: ev.role,
      payload: JSON.stringify(ev.payload),
      businessAt: getBusinessClock() ?? businessDateFromPayload(def, ev.payload) ?? new Date(),
      provenance,
      // Multi-tenant spine: stamp the resolved org + project at the single
      // EventLog write chokepoint (system org/project for the demo + non-request
      // contexts). projectId scopes the simulator's per-project data plane.
      organizationId: currentOrgId(),
      projectId: currentProjectId(),
    },
  });

  for (const fn of wildcardSubscribers) {
    await fn(ev);
  }
  for (const fn of subscribers.get(ev.ref) ?? []) {
    await fn(ev);
  }
}

export function _resetSubscribersForTests() {
  subscribers.clear();
  wildcardSubscribers.length = 0;
}
