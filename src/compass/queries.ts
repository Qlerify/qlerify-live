import { prisma } from "../db.js";

export async function listProductionSites() {
  return prisma.productionSite.findMany({ orderBy: { name: "asc" } });
}

export async function listProductionLines(siteId?: string) {
  return prisma.productionLine.findMany({
    where: siteId ? { siteId } : undefined,
    orderBy: [{ siteId: "asc" }, { name: "asc" }],
  });
}

export async function listLineBookings() {
  return prisma.lineBooking.findMany({ orderBy: { plannedStart: "asc" } });
}
