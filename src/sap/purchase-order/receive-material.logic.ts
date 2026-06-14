// AI/hand-authored business-logic region for command ReceiveMaterial.
// Realizes the Given/When/Then for "Material Received At Site", including the
// cross-aggregate side-effect of bumping build_demand.qty_available.
// Regenerate independently via: npm run codegen:ai -- ReceiveMaterial SAP

import { prisma } from "../../db.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import type { CommandContext, DetectInput, DetectResult } from "../../commands/runtime.js";
import type { ReceiveMaterialArgs } from "./receive-material.gen.js";

// Given a CONFIRMED PO, When goods are received, Then status becomes RECEIVED,
// actual_receipt_date is set, and build_demand.qty_available is incremented for
// any build line matching this part number on builds under the PO's project.
export async function apply(ctx: CommandContext<ReceiveMaterialArgs>) {
  const { args, role } = ctx;
  const po = await prisma.purchaseOrder.findUnique({ where: { id: args.id } });
  if (!po) throw new NotFoundError(`purchase order ${args.id} not found`);
  if (po.status !== "CONFIRMED") {
    throw new DomainError(`PO ${po.id} is ${po.status}; only CONFIRMED POs can be received`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: po.id, version: po.version },
      data: { status: "RECEIVED", actualReceiptDate: args.actualReceiptDate, version: { increment: 1 } },
    });
    const project = await tx.project.findUnique({ where: { id: po.projectId } });
    if (project) {
      const demand = await tx.demand.findUnique({ where: { id: project.demandId } });
      if (demand) {
        const plans = await tx.buildPlan.findMany({ where: { demandId: demand.id } });
        const builds = await tx.build.findMany({ where: { buildPlanId: { in: plans.map((p) => p.id) } } });
        for (const b of builds) {
          await tx.buildDemand.updateMany({
            where: { buildId: b.id, partNumber: po.partNumber },
            data: { qtyAvailable: { increment: po.qty } },
          });
        }
      }
    }
  });

  const updated = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
  await emit({
    ref: "#/domainEvents/MaterialReceivedAtSite",
    aggregateId: po.id,
    role,
    payload: { id: po.id, actualReceiptDate: args.actualReceiptDate, partNumber: po.partNumber, qty: po.qty },
  });
  return updated;
}

// Has material been received? True once the PO reached its terminal RECEIVED state.
export async function detect(input: DetectInput): Promise<DetectResult> {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: input.id } });
  if (!po) return { happened: false, evidence: `purchase order ${input.id} not found` };
  const happened = po.status === "RECEIVED";
  return {
    happened,
    evidence: happened
      ? `PO ${po.id} is RECEIVED; actualReceiptDate=${po.actualReceiptDate ?? "—"}`
      : `PO ${po.id} is ${po.status} — goods not yet received`,
  };
}

export const DESCRIBE =
  "Receive Material moves a CONFIRMED purchase order to RECEIVED, records the actual receipt date, and increments " +
  "the matching build demand's available quantity. Detection reads the PO state: the event has occurred once the PO is RECEIVED.";
