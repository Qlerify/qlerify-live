import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import { requireString } from "../../util/invariants.js";

async function loadPO(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw new NotFoundError(`purchase order ${id} not found`);
  return po;
}

// Order Material — DRAFT → ORDERED
export async function orderMaterial(args: { id: string; requestedDate: string }, role: Role) {
  assertRole(role, "Buyer");
  requireString("id", args.id);
  requireString("requestedDate", args.requestedDate);
  const po = await loadPO(args.id);
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

// Confirm Order With ETA — ORDERED → CONFIRMED
export async function confirmOrderWithETA(args: { id: string; confirmedEta: string }, role: Role) {
  assertRole(role, "Supplier");
  requireString("id", args.id);
  requireString("confirmedEta", args.confirmedEta);
  const po = await loadPO(args.id);
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

// Change Material ETA — supplier slips a CONFIRMED PO later
export async function changeMaterialETA(args: { id: string; confirmedEta: string }, role: Role) {
  assertRole(role, "Supplier");
  requireString("id", args.id);
  requireString("confirmedEta", args.confirmedEta);
  const po = await loadPO(args.id);
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

// Receive Material — CONFIRMED → RECEIVED, bump build_demand.qtyAvailable
export async function receiveMaterial(args: { id: string; actualReceiptDate: string }, role: Role) {
  assertRole(role, "Goods Receiving");
  requireString("id", args.id);
  requireString("actualReceiptDate", args.actualReceiptDate);
  const po = await loadPO(args.id);
  if (po.status !== "CONFIRMED") {
    throw new DomainError(`PO ${po.id} is ${po.status}; only CONFIRMED POs can be received`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: po.id, version: po.version },
      data: {
        status: "RECEIVED",
        actualReceiptDate: args.actualReceiptDate,
        version: { increment: 1 },
      },
    });
    // Bump qtyAvailable for any build_demand line matching this part number
    // on builds whose project matches this PO.
    const project = await tx.project.findUnique({ where: { id: po.projectId }, include: { bomItems: false } });
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
