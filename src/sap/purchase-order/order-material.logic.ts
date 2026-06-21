// AI/hand-authored business-logic region for command OrderMaterial.
// Realizes the Given/When/Then for "Material Ordered". Preserved across skeleton
// regeneration; regenerate independently via: npm run codegen:ai -- OrderMaterial SAP

import { prisma } from "../../db.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import type { CommandContext, DetectInput, DetectResult } from "../../commands/runtime.js";
import type { OrderMaterialArgs } from "./order-material.gen.js";

// Given a purchase order is in DRAFT, When the buyer orders the material,
// Then the PO status becomes ORDERED and requested_date is set.
export async function apply(ctx: CommandContext<OrderMaterialArgs>) {
  const { args, role } = ctx;
  const po = await prisma.purchaseOrder.findUnique({ where: { id: args.id } });
  if (!po) throw new NotFoundError(`purchase order ${args.id} not found`);
  if (po.status !== "DRAFT") {
    throw new DomainError(`PO ${po.id} is ${po.status}; only DRAFT POs can be ordered`);
  }
  const updated = await prisma.purchaseOrder.update({
    where: { id: po.id, version: po.version },
    data: { status: "ORDERED", requestedDate: args.requestedDate, version: { increment: 1 } },
  });
  await emit({
    ref: "#/domainEvents/MaterialOrdered",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, requestedDate: updated.requestedDate, status: updated.status },
  });
  return updated;
}

// Has "Material Ordered" happened for this PO? It has once the PO advanced past
// DRAFT (the lifecycle is monotonic: DRAFT → ORDERED → CONFIRMED → RECEIVED).
export async function detect(input: DetectInput): Promise<DetectResult> {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: input.id } });
  if (!po) return { happened: false, evidence: `purchase order ${input.id} not found` };
  const happened = po.status === "ORDERED" || po.status === "CONFIRMED" || po.status === "RECEIVED";
  return {
    happened,
    evidence: happened
      ? `PO ${po.id} is ${po.status} (past DRAFT); requestedDate=${po.requestedDate ?? "—"}`
      : `PO ${po.id} is still DRAFT — material not ordered yet`,
  };
}

export const DESCRIBE =
  "Order Material moves a purchase order from DRAFT to ORDERED and records the buyer's requested delivery date. " +
  "Detection reads the PO state: the event has occurred once the PO is past DRAFT (ORDERED, CONFIRMED or RECEIVED).";
