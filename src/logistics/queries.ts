import { prisma } from "../db.js";

export async function listShipmentsReady() {
  return prisma.shipment.findMany({
    where: { status: "READY" },
    include: { units: true },
    orderBy: { packedAt: "asc" },
  });
}

export async function listShipments() {
  return prisma.shipment.findMany({
    include: { units: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getShipment(shipmentId: string) {
  return prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { units: true },
  });
}

export async function listUnits(buildId?: string) {
  return prisma.unit.findMany({
    where: buildId ? { buildId } : undefined,
  });
}
