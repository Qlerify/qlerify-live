import { prisma } from "../db.js";

export async function listDemands() {
  return prisma.demand.findMany({ orderBy: { createdAt: "desc" } });
}

export async function getDemand(demandId: string) {
  return prisma.demand.findUnique({ where: { id: demandId } });
}

export async function getDemandWithBOMStatus(demandId: string) {
  const demand = await prisma.demand.findUnique({ where: { id: demandId } });
  if (!demand) return null;
  const project = await prisma.project.findFirst({
    where: { demandId },
    include: { bomItems: true },
  });
  const projectStatus = project
    ? project.bomItems.length === 0
      ? "NO_BOM"
      : project.bomItems.every((i) => i.designState === "DS2_PROD")
        ? "DS2_PROD"
        : project.bomItems.every((i) => i.designState !== "DRAFT")
          ? "DS1"
          : "DRAFT"
    : "NO_PROJECT";
  return { ...demand, projectStatus };
}

export async function getBuildWithBOM(buildId: string) {
  const build = await prisma.build.findUnique({
    where: { id: buildId },
    include: { buildPlan: true },
  });
  if (!build) return null;
  const project = await prisma.project.findFirst({ where: { demandId: build.buildPlan.demandId } });
  const bomItems = project
    ? await prisma.bomItem.findMany({ where: { projectId: project.id } })
    : [];
  return { ...build, bomItems };
}

export async function listBuildsAtRisk() {
  return prisma.build.findMany({
    where: { materialStatus: "AT_RISK" },
    orderBy: { plannedStart: "asc" },
  });
}

export async function listBuilds(buildPlanId?: string) {
  return prisma.build.findMany({
    where: buildPlanId ? { buildPlanId } : undefined,
    orderBy: [{ priority: "asc" }, { buildNo: "asc" }],
    include: { buildDemand: true },
  });
}

export async function getBuildPlanDisruptions(demandId: string) {
  const plans = await prisma.buildPlan.findMany({
    where: { demandId },
    orderBy: { versionNo: "desc" },
  });
  if (plans.length === 0) return null;
  const latest = plans[0]!;
  const builds = await prisma.build.findMany({ where: { buildPlanId: latest.id } });
  const project = await prisma.project.findFirst({ where: { demandId } });
  const etaSlips = await prisma.purchaseOrder.findMany({
    where: { projectId: project?.id ?? "" },
  });
  const slipPOs = etaSlips.filter((p) => p.confirmedEta && builds.some((b) => p.confirmedEta! > b.plannedStart));
  const approvedECs = await prisma.engineeringChange.count({
    where: { projectId: project?.id ?? "", status: "APPROVED", approvedAt: { gt: latest.createdAt.toISOString() } },
  });
  return { ...latest, etaSlipCount: slipPOs.length, approvedEngineeringChanges: approvedECs };
}

export async function getBuildPlanLockReadiness(buildPlanId: string) {
  const plan = await prisma.buildPlan.findUnique({ where: { id: buildPlanId } });
  if (!plan) return null;
  const project = await prisma.project.findFirst({
    where: { demandId: plan.demandId },
    include: { bomItems: true },
  });
  const ds2Frozen = !!project && project.bomItems.length > 0 && project.bomItems.every((i) => i.designState === "DS2_PROD");
  const er = project ? await prisma.engineeringRelease.findUnique({ where: { projectId: project.id } }) : null;
  const engineeringReleaseApproved = er?.status === "APPROVED";
  const builds = await prisma.build.findMany({ where: { buildPlanId: plan.id } });
  const workOrders = await prisma.workOrder.findMany({ where: { buildId: { in: builds.map((b) => b.id) } } });
  const workOrderCreated = builds.length > 0 && workOrders.length >= builds.length;
  return { ...plan, ds2Frozen, engineeringReleaseApproved, workOrderCreated };
}

export async function getBuildMaterialStatus(buildId: string) {
  const build = await prisma.build.findUnique({
    where: { id: buildId },
    include: { buildDemand: true },
  });
  if (!build) return null;
  const isKitComplete = build.buildDemand.length > 0 && build.buildDemand.every((d) => d.qtyAvailable >= d.qtyRequired);
  return { ...build, isKitComplete };
}

export async function getBuildProductionReadiness(buildId: string) {
  const build = await prisma.build.findUnique({ where: { id: buildId } });
  if (!build) return null;
  const booking = await prisma.lineBooking.findFirst({ where: { buildId } });
  return { ...build, lineBookingStatus: booking?.status ?? "NONE" };
}

export async function listBuildsInProduction() {
  return prisma.build.findMany({ where: { status: "IN_PROGRESS" } });
}

export async function listBuildsReadyForFAI() {
  const candidates = await prisma.build.findMany({ where: { status: "IN_PROGRESS" } });
  const out: Array<typeof candidates[number] & { boardTestsPassed: boolean }> = [];
  for (const b of candidates) {
    const boards = await prisma.testResult.count({ where: { buildId: b.id, testType: "BOARD", result: "PASS" } });
    out.push({ ...b, boardTestsPassed: boards >= b.qty });
  }
  return out.filter((b) => b.boardTestsPassed);
}

export async function getBuildTestStatus(buildId: string) {
  const build = await prisma.build.findUnique({ where: { id: buildId } });
  if (!build) return null;
  const board = await prisma.testResult.count({ where: { buildId, testType: "BOARD", result: "PASS" } });
  const fai = await prisma.testResult.count({ where: { buildId, testType: "FAI", result: "PASS" } });
  return { ...build, boardTestsPassed: board >= build.qty, faiPassed: fai > 0 };
}

export async function listBuildsReadyForPack() {
  return prisma.build.findMany({
    where: { status: "RTD" },
    include: { /* units come via Unit.buildId */ },
  });
}
