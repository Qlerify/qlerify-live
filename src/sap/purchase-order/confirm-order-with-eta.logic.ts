// AI/hand-authored business-logic region for command ConfirmOrderWithETA.
// Realizes the Given/When/Then for "Supplier Confirmed Order With ETA".
// Regenerate independently via: npm run codegen:ai -- ConfirmOrderWithETA SAP

import { prisma } from "../../db.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import type { CommandContext, DetectInput, DetectResult } from "../../commands/runtime.js";
import type { ConfirmOrderWithETAArgs } from "./confirm-order-with-eta.gen.js";

// Given a purchase order is ORDERED, When the supplier confirms,
// Then the PO status becomes CONFIRMED and confirmed_eta is set.
export async function apply(ctx: CommandContext<ConfirmOrderWithETAArgs>) {
  const { args, role } = ctx;
  const po = await prisma.purchaseOrder.findUnique({ where: { id: args.id } });
  if (!po) throw new NotFoundError(`purchase order ${args.id} not found`);
  if (po.status !== "ORDERED") {
    throw new DomainError(`PO ${po.id} is ${po.status}; supplier can only confirm ORDERED POs`);
  }
  const updated = await prisma.purchaseOrder.update({
    where: { id: po.id, version: po.version },
    data: { status: "CONFIRMED", confirmedEta: args.confirmedEta, version: { increment: 1 } },
  });
  await emit({
    ref: "#/domainEvents/SupplierConfirmedOrderWithETA",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, confirmedEta: updated.confirmedEta, status: updated.status },
  });
  return updated;
}

// Has the supplier confirmed? True once the PO reached CONFIRMED (or beyond).
export async function detect(input: DetectInput): Promise<DetectResult> {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: input.id } });
  if (!po) return { happened: false, evidence: `purchase order ${input.id} not found` };
  const happened = po.status === "CONFIRMED" || po.status === "RECEIVED";
  return {
    happened,
    evidence: happened
      ? `PO ${po.id} is ${po.status}; confirmedEta=${po.confirmedEta ?? "—"}`
      : `PO ${po.id} is ${po.status} — supplier has not confirmed an ETA yet`,
  };
}

export const DESCRIBE =
  "Confirm Order With ETA moves a purchase order from ORDERED to CONFIRMED and records the supplier's ETA. " +
  "Detection reads the PO state: the event has occurred once the PO is CONFIRMED or RECEIVED.";
