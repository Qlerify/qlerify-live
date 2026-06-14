// AI/hand-authored business-logic region for command ChangeMaterialETA.
// Realizes the Given/When/Then for "Material ETA Changed" (the supplier slips a
// CONFIRMED PO to a strictly later date).
// Regenerate independently via: npm run codegen:ai -- ChangeMaterialETA SAP

import { prisma } from "../../db.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import type { CommandContext, DetectInput, DetectResult } from "../../commands/runtime.js";
import type { ChangeMaterialETAArgs } from "./change-material-eta.gen.js";

// Given a CONFIRMED PO, When the supplier submits a strictly later ETA, Then
// confirmed_eta is updated. An equal-or-earlier ETA is rejected with a DomainError.
export async function apply(ctx: CommandContext<ChangeMaterialETAArgs>) {
  const { args, role } = ctx;
  const po = await prisma.purchaseOrder.findUnique({ where: { id: args.id } });
  if (!po) throw new NotFoundError(`purchase order ${args.id} not found`);
  if (po.status !== "CONFIRMED") {
    throw new DomainError(`PO ${po.id} is ${po.status}; ETA can only be changed on CONFIRMED POs`);
  }
  if (po.confirmedEta && args.confirmedEta <= po.confirmedEta) {
    throw new DomainError("new ETA must be later than the previous confirmed ETA");
  }
  const updated = await prisma.purchaseOrder.update({
    where: { id: po.id, version: po.version },
    data: { confirmedEta: args.confirmedEta, version: { increment: 1 } },
  });
  await emit({
    ref: "#/domainEvents/MaterialETAChanged",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, confirmedEta: updated.confirmedEta, previousEta: po.confirmedEta },
  });
  return updated;
}

// "Material ETA Changed" is a repeatable event on a single state, so current
// aggregate state cannot prove it fired — the event log is authoritative.
export async function detect(input: DetectInput): Promise<DetectResult> {
  const count = await prisma.eventLog.count({
    where: { eventRef: "#/domainEvents/MaterialETAChanged", aggregateId: input.id },
  });
  return {
    happened: count > 0,
    evidence: count > 0
      ? `${count} MaterialETAChanged event(s) recorded for PO ${input.id}`
      : `no MaterialETAChanged event recorded for PO ${input.id}`,
  };
}

export const DESCRIBE =
  "Change Material ETA records a supplier slipping a CONFIRMED purchase order to a strictly later ETA; " +
  "an equal-or-earlier ETA is rejected. Detection counts MaterialETAChanged entries in the event log for the PO, " +
  "because the change does not alter the PO's lifecycle status and so leaves no distinguishing current-state marker.";
