import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import { newId } from "../../util/ids.js";
import { requireString, requirePositiveInt } from "../../util/invariants.js";

export interface DefineBuildQuantityArgs {
  demandId: string;
  builds: Array<{ buildNo: string; qty: number; plannedStart: string }>;
}

export async function defineBuildQuantity(args: DefineBuildQuantityArgs, role: Role) {
  assertRole(role, "Planner");
  requireString("demandId", args.demandId);
  if (!Array.isArray(args.builds) || args.builds.length === 0) {
    throw new DomainError("builds must be a non-empty array");
  }
  for (const [i, b] of args.builds.entries()) {
    requireString(`builds[${i}].buildNo`, b.buildNo);
    requirePositiveInt(`builds[${i}].qty`, b.qty);
    requireString(`builds[${i}].plannedStart`, b.plannedStart);
  }

  // Precondition: BOM must be frozen at DS1 on the demand's project.
  const project = await prisma.project.findFirst({
    where: { demandId: args.demandId },
    include: { bomItems: true },
  });
  if (!project) throw new DomainError(`no project exists for demand ${args.demandId}`);
  if (project.bomItems.length === 0) throw new DomainError("BOM has not been defined yet");
  const notDs1 = project.bomItems.filter((i) => i.designState === "DRAFT");
  if (notDs1.length > 0) throw new DomainError(`BOM is not frozen at DS1 (${notDs1.length} draft items)`);

  const planId = newId("bp");
  const plan = await prisma.buildPlan.create({
    data: {
      id: planId,
      demandId: args.demandId,
      versionNo: 1,
      status: "DRAFT",
      builds: {
        create: args.builds.map((b) => ({
          id: newId("build"),
          buildNo: b.buildNo,
          qty: b.qty,
          plannedStart: b.plannedStart,
          materialStatus: "OPEN",
          status: "PLANNED",
        })),
      },
    },
    include: { builds: true },
  });

  await prisma.demand.update({
    where: { id: args.demandId },
    data: { status: "PLANNED", version: { increment: 1 } },
  });

  await emit({
    ref: "#/domainEvents/BuildQuantityDefined",
    aggregateId: plan.id,
    role,
    payload: { id: plan.id, demandId: args.demandId, versionNo: plan.versionNo, buildCount: plan.builds.length },
  });

  return plan;
}

export interface UpdateBuildPlanArgs {
  demandId: string;
  reason: string; // ETA_CHANGED | ER_APPROVED | PRIORITY_CHANGED | SITE_CHANGED
}

export async function updateBuildPlan(args: UpdateBuildPlanArgs, role: Role) {
  assertRole(role, "Planner");
  requireString("demandId", args.demandId);
  requireString("reason", args.reason);

  const latest = await prisma.buildPlan.findFirst({
    where: { demandId: args.demandId },
    orderBy: { versionNo: "desc" },
  });
  if (!latest) throw new NotFoundError(`no build plan exists for demand ${args.demandId}`);
  if (latest.status === "LOCKED") {
    throw new DomainError("cannot create a new plan version while a locked plan exists; release first");
  }

  // Create v(N+1), move all builds from v(N) → v(N+1), and mark v(N) SUPERSEDED.
  // This matches the spec's "previous version archived" while keeping every build
  // attached to exactly one current plan.
  const newPlan = await prisma.$transaction(async (tx) => {
    const created = await tx.buildPlan.create({
      data: {
        id: newId("bp"),
        demandId: args.demandId,
        versionNo: latest.versionNo + 1,
        status: "DRAFT",
        reason: args.reason,
      },
    });
    await tx.build.updateMany({
      where: { buildPlanId: latest.id },
      data: { buildPlanId: created.id },
    });
    await tx.buildPlan.update({
      where: { id: latest.id },
      data: { status: "SUPERSEDED", version: { increment: 1 } },
    });
    return created;
  });

  await emit({
    ref: "#/domainEvents/BuildPlanUpdated",
    aggregateId: newPlan.id,
    role,
    payload: { id: newPlan.id, demandId: args.demandId, versionNo: newPlan.versionNo, reason: args.reason },
  });

  return newPlan;
}

export interface LockBuildPlanArgs {
  id: string;
}

export async function lockBuildPlan(args: LockBuildPlanArgs, role: Role) {
  assertRole(role, "Planner");
  requireString("id", args.id);

  const plan = await prisma.buildPlan.findUnique({ where: { id: args.id } });
  if (!plan) throw new NotFoundError(`build plan ${args.id} not found`);
  if (plan.status !== "DRAFT") {
    throw new DomainError(`build plan ${args.id} is ${plan.status}; only DRAFT plans can be locked`);
  }

  const project = await prisma.project.findFirst({
    where: { demandId: plan.demandId },
    include: { bomItems: true },
  });
  if (!project) throw new DomainError("project missing for lock readiness check");

  const notDs2 = project.bomItems.filter((i) => i.designState !== "DS2_PROD");
  if (notDs2.length > 0) {
    throw new DomainError(`Lock denied: BOM not frozen at DS2 (${notDs2.length} items still ${notDs2[0]!.designState})`);
  }

  const er = await prisma.engineeringRelease.findUnique({ where: { projectId: project.id } });
  if (!er || er.status !== "APPROVED") {
    throw new DomainError("Lock denied: engineering release not approved");
  }

  // Side effect: ensure a work_order exists for every build on this plan
  const builds = await prisma.build.findMany({ where: { buildPlanId: plan.id } });
  for (const b of builds) {
    const existing = await prisma.workOrder.findFirst({ where: { buildId: b.id } });
    if (!existing) {
      await prisma.workOrder.create({
        data: {
          projectId: project.id,
          buildId: b.id,
          qty: b.qty,
          status: "CREATED",
        },
      });
    }
  }

  const locked = await prisma.buildPlan.update({
    where: { id: args.id, version: plan.version },
    data: {
      status: "LOCKED",
      lockedAt: new Date().toISOString(),
      version: { increment: 1 },
    },
  });

  await emit({
    ref: "#/domainEvents/BuildPlanLocked",
    aggregateId: locked.id,
    role,
    payload: { id: locked.id, lockedAt: locked.lockedAt },
  });

  return locked;
}
