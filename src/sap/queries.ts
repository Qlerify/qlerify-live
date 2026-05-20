import { prisma } from "../db.js";

export async function listDraftPurchaseOrders() {
  return prisma.purchaseOrder.findMany({ where: { status: "DRAFT" }, orderBy: { partNumber: "asc" } });
}

export async function getPurchaseOrder(poId: string) {
  return prisma.purchaseOrder.findUnique({ where: { id: poId } });
}

export async function listPurchaseOrdersByStatus(status?: string) {
  return prisma.purchaseOrder.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ status: "asc" }, { partNumber: "asc" }],
  });
}

export async function listWorkOrders() {
  return prisma.workOrder.findMany({ orderBy: { status: "asc" } });
}
