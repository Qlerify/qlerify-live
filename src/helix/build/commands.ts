import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import { newId } from "../../util/ids.js";
import { requireString, requirePositiveInt, requireNonNegativeInt } from "../../util/invariants.js";

// -----------------------------------------------------------------------
// Specify Material Demand — supply planner declares per-build BOM rollup
// Side effect: creates DRAFT purchase_orders in SAP.
// -----------------------------------------------------------------------

export interface SpecifyMaterialDemandArgs {
  id: string; // build id
  buildDemand: Array<{ partNumber: string; qtyRequired: number }>;
}

export async function specifyMaterialDemand(args: SpecifyMaterialDemandArgs, role: Role) {
  assertRole(role, "Supply Planner");
  requireString("id", args.id);
  if (!Array.isArray(args.buildDemand) || args.buildDemand.length === 0) {
    throw new DomainError("buildDemand must be a non-empty array");
  }
  for (const [i, d] of args.buildDemand.entries()) {
    requireString(`buildDemand[${i}].partNumber`, d.partNumber);
    requirePositiveInt(`buildDemand[${i}].qtyRequired`, d.qtyRequired);
  }

  const build = await prisma.build.findUnique({
    where: { id: args.id },
    include: { buildPlan: true },
  });
  if (!build) throw new NotFoundError(`build ${args.id} not found`);

  // Resolve the project that owns this demand's BOM (for PO projectId)
  const project = await prisma.project.findFirst({ where: { demandId: build.buildPlan.demandId } });
  if (!project) throw new DomainError("project missing for material demand");

  await prisma.$transaction(async (tx) => {
    for (const d of args.buildDemand) {
      await tx.buildDemand.upsert({
        where: { buildId_partNumber: { buildId: build.id, partNumber: d.partNumber } },
        create: {
          buildId: build.id,
          partNumber: d.partNumber,
          qtyRequired: d.qtyRequired,
        },
        update: { qtyRequired: d.qtyRequired },
      });
      // Side effect: draft purchase order per part (simulating SAP write)
      await tx.purchaseOrder.create({
        data: {
          projectId: project.id,
          partNumber: d.partNumber,
          qty: d.qtyRequired,
          supplierId: `sup-${d.partNumber.slice(-2)}`,
          status: "DRAFT",
        },
      });
    }
  });

  await emit({
    ref: "#/domainEvents/MaterialDemandSpecified",
    aggregateId: build.id,
    role,
    payload: { id: build.id, lineCount: args.buildDemand.length },
  });

  return prisma.build.findUnique({ where: { id: args.id }, include: { buildDemand: true } });
}

// -----------------------------------------------------------------------
// Flag Material Shortage — derived/automation event
// -----------------------------------------------------------------------

export async function flagMaterialShortage(args: { id: string }, role: Role) {
  assertRole(role, "Automation");
  requireString("id", args.id);
  const build = await prisma.build.findUnique({ where: { id: args.id } });
  if (!build) throw new NotFoundError(`build ${args.id} not found`);
  if (build.materialStatus === "KIT_READY") {
    throw new DomainError("cannot flag shortage on a build whose material is KIT_READY");
  }
  const updated = await prisma.build.update({
    where: { id: build.id, version: build.version },
    data: { materialStatus: "AT_RISK", version: { increment: 1 } },
  });
  await emit({
    ref: "#/domainEvents/MaterialShortageIdentified",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, materialStatus: updated.materialStatus },
  });
  return updated;
}

// -----------------------------------------------------------------------
// Set Build Priority
// -----------------------------------------------------------------------

export async function setBuildPriority(args: { id: string; priority: number }, role: Role) {
  assertRole(role, "Planner");
  requireString("id", args.id);
  requireNonNegativeInt("priority", args.priority);
  const build = await prisma.build.findUnique({ where: { id: args.id } });
  if (!build) throw new NotFoundError(`build ${args.id} not found`);
  const updated = await prisma.build.update({
    where: { id: build.id, version: build.version },
    data: { priority: args.priority, version: { increment: 1 } },
  });
  await emit({
    ref: "#/domainEvents/BuildPrioritySet",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, priority: updated.priority },
  });
  return updated;
}

// -----------------------------------------------------------------------
// Release Build To Site — gates on the LOCKED plan
// -----------------------------------------------------------------------

export async function releaseBuildToSite(args: { id: string; siteId: string }, role: Role) {
  assertRole(role, "Planner");
  requireString("id", args.id);
  requireString("siteId", args.siteId);
  const build = await prisma.build.findUnique({
    where: { id: args.id },
    include: { buildPlan: true },
  });
  if (!build) throw new NotFoundError(`build ${args.id} not found`);
  if (build.buildPlan.status !== "LOCKED") {
    throw new DomainError(`build plan is ${build.buildPlan.status}; must be LOCKED to release`);
  }
  if (build.status !== "PLANNED") {
    throw new DomainError(`build is ${build.status}; only PLANNED builds can be released`);
  }
  const site = await prisma.productionSite.findUnique({ where: { id: args.siteId } });
  if (!site) throw new DomainError(`production site ${args.siteId} does not exist`);

  const updated = await prisma.build.update({
    where: { id: build.id, version: build.version },
    data: { siteId: args.siteId, status: "RELEASED", version: { increment: 1 } },
  });
  // Side effect: bump the plan to RELEASED
  await prisma.buildPlan.update({
    where: { id: build.buildPlanId },
    data: { status: "RELEASED", releasedAt: new Date().toISOString(), version: { increment: 1 } },
  });

  await emit({
    ref: "#/domainEvents/BuildReleasedToSite",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, siteId: args.siteId, status: updated.status },
  });
  return updated;
}

// -----------------------------------------------------------------------
// Complete Material Kit — derived/automation event
// -----------------------------------------------------------------------

export async function completeMaterialKit(args: { id: string }, role: Role) {
  assertRole(role, "Automation");
  requireString("id", args.id);
  const build = await prisma.build.findUnique({
    where: { id: args.id },
    include: { buildDemand: true },
  });
  if (!build) throw new NotFoundError(`build ${args.id} not found`);
  const unsatisfied = build.buildDemand.filter((d) => d.qtyAvailable < d.qtyRequired);
  if (unsatisfied.length > 0) {
    throw new DomainError(`material kit incomplete: ${unsatisfied.length} parts under-supplied`);
  }
  if (build.materialStatus === "KIT_READY") return build; // idempotent

  const updated = await prisma.build.update({
    where: { id: build.id, version: build.version },
    data: { materialStatus: "KIT_READY", version: { increment: 1 } },
  });
  await emit({
    ref: "#/domainEvents/MaterialKitCompleted",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, materialStatus: updated.materialStatus },
  });
  return updated;
}

// -----------------------------------------------------------------------
// Start Production — gates on material KIT_READY AND line BOOKED
// -----------------------------------------------------------------------

export async function startProduction(args: { id: string; actualStart: string }, role: Role) {
  assertRole(role, "Production");
  requireString("id", args.id);
  requireString("actualStart", args.actualStart);
  const build = await prisma.build.findUnique({ where: { id: args.id } });
  if (!build) throw new NotFoundError(`build ${args.id} not found`);
  if (build.materialStatus !== "KIT_READY") {
    throw new DomainError(`cannot start production: material is ${build.materialStatus}`);
  }
  const booking = await prisma.lineBooking.findFirst({ where: { buildId: build.id } });
  if (!booking) throw new DomainError("cannot start production: no production line booked");
  if (booking.status !== "BOOKED") {
    throw new DomainError(`cannot start production: line is ${booking.status}`);
  }

  const updated = await prisma.build.update({
    where: { id: build.id, version: build.version },
    data: { status: "IN_PROGRESS", actualStart: args.actualStart, version: { increment: 1 } },
  });
  await prisma.lineBooking.update({
    where: { id: booking.id },
    data: { status: "RUNNING", version: { increment: 1 } },
  });

  await emit({
    ref: "#/domainEvents/ProductionStarted",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, actualStart: updated.actualStart, lineBookingId: booking.id },
  });
  return updated;
}

// -----------------------------------------------------------------------
// Mark Build As RTD — gates on FAI test passed; side effects on
// line_booking, work_order, and creates N unit rows.
// -----------------------------------------------------------------------

export async function markBuildAsRTD(args: { id: string; actualEnd: string }, role: Role) {
  assertRole(role, "Quality Engineer");
  requireString("id", args.id);
  requireString("actualEnd", args.actualEnd);
  const build = await prisma.build.findUnique({ where: { id: args.id } });
  if (!build) throw new NotFoundError(`build ${args.id} not found`);
  if (build.status !== "IN_PROGRESS") {
    throw new DomainError(`build is ${build.status}; only IN_PROGRESS builds can reach RTD`);
  }
  const fai = await prisma.testResult.findFirst({
    where: { buildId: build.id, testType: "FAI", result: "PASS" },
  });
  if (!fai) throw new DomainError("FAI test has not passed for this build");

  const units: { id: string; serialNo: string }[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.build.update({
      where: { id: build.id, version: build.version },
      data: { status: "RTD", actualEnd: args.actualEnd, version: { increment: 1 } },
    });
    const booking = await tx.lineBooking.findFirst({ where: { buildId: build.id } });
    if (booking) {
      await tx.lineBooking.update({
        where: { id: booking.id },
        data: { status: "DONE", version: { increment: 1 } },
      });
    }
    const wo = await tx.workOrder.findFirst({ where: { buildId: build.id } });
    if (wo) {
      await tx.workOrder.update({
        where: { id: wo.id },
        data: { status: "CLOSED", version: { increment: 1 } },
      });
    }
    for (let i = 1; i <= build.qty; i++) {
      const u = await tx.unit.create({
        data: {
          buildId: build.id,
          serialNo: `${build.buildNo}-SN-${i.toString().padStart(4, "0")}`,
          status: "BUILT",
        },
      });
      units.push({ id: u.id, serialNo: u.serialNo });
    }
  });

  await emit({
    ref: "#/domainEvents/BuildReachedRTD",
    aggregateId: build.id,
    role,
    payload: { id: build.id, actualEnd: args.actualEnd, unitCount: units.length },
  });
  return { id: build.id, units };
}
