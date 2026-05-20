// Static reference data per spec §8: one production site with two lines.
// All transactional state (demands, projects, builds, …) is created by
// firing the 28 events of the simulator — not by the seed.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.productionSite.upsert({
    where: { id: "site-stockholm" },
    create: { id: "site-stockholm", name: "Stockholm" },
    update: { name: "Stockholm" },
  });
  await prisma.productionSite.upsert({
    where: { id: "site-tallinn" },
    create: { id: "site-tallinn", name: "Tallinn" },
    update: { name: "Tallinn" },
  });
  await prisma.productionLine.upsert({
    where: { id: "line-A1" },
    create: { id: "line-A1", siteId: "site-stockholm", name: "Stockholm A1", capacityPerWeek: 50 },
    update: { siteId: "site-stockholm", name: "Stockholm A1", capacityPerWeek: 50 },
  });
  await prisma.productionLine.upsert({
    where: { id: "line-A2" },
    create: { id: "line-A2", siteId: "site-stockholm", name: "Stockholm A2", capacityPerWeek: 100 },
    update: { siteId: "site-stockholm", name: "Stockholm A2", capacityPerWeek: 100 },
  });
  await prisma.productionLine.upsert({
    where: { id: "line-B1" },
    create: { id: "line-B1", siteId: "site-tallinn", name: "Tallinn B1", capacityPerWeek: 75 },
    update: { siteId: "site-tallinn", name: "Tallinn B1", capacityPerWeek: 75 },
  });
  console.log("seeded: 2 sites, 3 lines");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
