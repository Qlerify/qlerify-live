import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import { newId } from "../../util/ids.js";
import { requireString, requirePositiveInt } from "../../util/invariants.js";

// -----------------------------------------------------------------------
// Create Project — links a PRIM project to a Helix demand
// -----------------------------------------------------------------------

export interface CreateProjectArgs {
  demandId: string;
  productName: string;
}

export async function createProject(args: CreateProjectArgs, role: Role) {
  assertRole(role, "Product Manager");
  requireString("demandId", args.demandId);
  requireString("productName", args.productName);

  const demand = await prisma.demand.findUnique({ where: { id: args.demandId } });
  if (!demand) throw new DomainError(`demand ${args.demandId} does not exist`);

  const existing = await prisma.project.findFirst({ where: { demandId: args.demandId } });
  if (existing) throw new DomainError(`a project already exists for demand ${args.demandId}`);

  const id = newId("proj");
  const project = await prisma.project.create({
    data: { id, demandId: args.demandId, productName: args.productName, status: "ACTIVE" },
  });

  await emit({
    ref: "#/domainEvents/ProjectCreated",
    aggregateId: project.id,
    role,
    payload: { id: project.id, demandId: args.demandId, productName: args.productName },
  });
  return project;
}

// -----------------------------------------------------------------------
// Define BOM — designer inserts N BOM lines (designState = DRAFT)
// -----------------------------------------------------------------------

export interface DefineBOMArgs {
  id: string; // projectId
  bomItems: Array<{ partNumber: string; qtyPerUnit: number }>;
}

export async function defineBOM(args: DefineBOMArgs, role: Role) {
  assertRole(role, "Designer");
  requireString("id", args.id);
  if (!Array.isArray(args.bomItems) || args.bomItems.length === 0) {
    throw new DomainError("bomItems must be a non-empty array");
  }
  for (const [i, b] of args.bomItems.entries()) {
    requireString(`bomItems[${i}].partNumber`, b.partNumber);
    requirePositiveInt(`bomItems[${i}].qtyPerUnit`, b.qtyPerUnit);
  }

  const project = await prisma.project.findUnique({ where: { id: args.id } });
  if (!project) throw new NotFoundError(`project ${args.id} not found`);

  await prisma.$transaction(async (tx) => {
    for (const b of args.bomItems) {
      await tx.bomItem.create({
        data: {
          projectId: project.id,
          partNumber: b.partNumber,
          qtyPerUnit: b.qtyPerUnit,
          designState: "DRAFT",
        },
      });
    }
  });

  await emit({
    ref: "#/domainEvents/BOMDefined",
    aggregateId: project.id,
    role,
    payload: { id: project.id, bomItemCount: args.bomItems.length },
  });
  return prisma.project.findUnique({ where: { id: project.id }, include: { bomItems: true } });
}

// -----------------------------------------------------------------------
// Freeze BOM At DS1 — CM transitions all DRAFT items to DS1
// -----------------------------------------------------------------------

export async function freezeBOMAtDS1(args: { id: string }, role: Role) {
  assertRole(role, "Configuration Manager");
  requireString("id", args.id);
  const project = await prisma.project.findUnique({
    where: { id: args.id },
    include: { bomItems: true },
  });
  if (!project) throw new NotFoundError(`project ${args.id} not found`);
  if (project.bomItems.length === 0) throw new DomainError("BOM has no items to freeze");
  const draftItems = project.bomItems.filter((i) => i.designState === "DRAFT");
  if (draftItems.length === 0) throw new DomainError("no draft items to freeze");

  const frozenAt = new Date().toISOString();
  await prisma.bomItem.updateMany({
    where: { projectId: project.id, designState: "DRAFT" },
    data: { designState: "DS1", frozenAt },
  });

  await emit({
    ref: "#/domainEvents/BOMFrozenAtDS1",
    aggregateId: project.id,
    role,
    payload: { id: project.id, frozenAt, itemCount: draftItems.length },
  });
  return prisma.project.findUnique({ where: { id: project.id }, include: { bomItems: true } });
}

// -----------------------------------------------------------------------
// Freeze BOM At DS2 — requires all ECs resolved
// -----------------------------------------------------------------------

export async function freezeBOMAtDS2(args: { id: string }, role: Role) {
  assertRole(role, "Configuration Manager");
  requireString("id", args.id);
  const project = await prisma.project.findUnique({
    where: { id: args.id },
    include: { bomItems: true },
  });
  if (!project) throw new NotFoundError(`project ${args.id} not found`);

  const ds1Items = project.bomItems.filter((i) => i.designState === "DS1");
  if (ds1Items.length === 0) {
    throw new DomainError("no DS1 items to freeze at DS2");
  }
  const openECs = await prisma.engineeringChange.findMany({
    where: { projectId: project.id, status: "OPEN" },
  });
  if (openECs.length > 0) {
    throw new DomainError(`cannot freeze at DS2: ${openECs.length} engineering change(s) still OPEN`);
  }

  const frozenAt = new Date().toISOString();
  await prisma.bomItem.updateMany({
    where: { projectId: project.id, designState: "DS1" },
    data: { designState: "DS2_PROD", frozenAt },
  });

  await emit({
    ref: "#/domainEvents/BOMFrozenAtDS2",
    aggregateId: project.id,
    role,
    payload: { id: project.id, frozenAt, itemCount: ds1Items.length },
  });
  return prisma.project.findUnique({ where: { id: project.id }, include: { bomItems: true } });
}
