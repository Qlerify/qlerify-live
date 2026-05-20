// In-process event bus. Each command handler emits its event after the
// aggregate write commits. Subscribers run synchronously on the same tick;
// derived events (Material Shortage Identified, Material Kit Completed)
// subscribe to upstream events and emit their own.

import { prisma } from "../db.js";
import { findEvent } from "./registry.js";
import { getBusinessClock } from "./clock.js";
import type { Role } from "../auth.js";

export interface EmittedEvent {
  ref: string;             // e.g. "#/domainEvents/HardwareDemandCreated"
  aggregateId: string;
  role: Role;
  payload: Record<string, unknown>;
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

export function subscribe(ref: string, fn: Subscriber) {
  const list = subscribers.get(ref) ?? [];
  list.push(fn);
  subscribers.set(ref, list);
}

export function subscribeAll(fn: Subscriber) {
  wildcardSubscribers.push(fn);
}

export async function emit(ev: EmittedEvent): Promise<void> {
  const def = findEvent(ev.ref);
  const demandId = await resolveDemandId(def.aggregateRoot, ev.aggregateId, ev.payload);

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
      businessAt: getBusinessClock(),
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
