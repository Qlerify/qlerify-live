import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError, NotFoundError } from "../../errors.js";
import { requireString } from "../../util/invariants.js";

export interface RaiseEngineeringChangeArgs {
  projectId: string;
  bomItemId: string;
  description: string;
}

export async function raiseEngineeringChange(args: RaiseEngineeringChangeArgs, role: Role) {
  assertRole(role, "Designer");
  requireString("projectId", args.projectId);
  requireString("bomItemId", args.bomItemId);
  requireString("description", args.description);

  const bomItem = await prisma.bomItem.findUnique({ where: { id: args.bomItemId } });
  if (!bomItem) throw new DomainError(`bom item ${args.bomItemId} does not exist`);
  if (bomItem.projectId !== args.projectId) {
    throw new DomainError("bomItemId does not belong to the given projectId");
  }
  if (bomItem.designState === "DRAFT") {
    throw new DomainError("engineering changes only apply once the BOM is at least at DS1");
  }

  const ec = await prisma.engineeringChange.create({
    data: {
      projectId: args.projectId,
      bomItemId: args.bomItemId,
      description: args.description,
      status: "OPEN",
      createdAt: new Date().toISOString(),
    },
  });

  await emit({
    ref: "#/domainEvents/EngineeringChangeRaised",
    aggregateId: ec.id,
    role,
    payload: { id: ec.id, projectId: args.projectId, bomItemId: args.bomItemId, description: args.description },
  });
  return ec;
}

export async function approveEngineeringChange(args: { id: string }, role: Role) {
  assertRole(role, "Configuration Manager");
  requireString("id", args.id);
  const ec = await prisma.engineeringChange.findUnique({ where: { id: args.id } });
  if (!ec) throw new NotFoundError(`engineering change ${args.id} not found`);
  if (ec.status !== "OPEN") {
    throw new DomainError(`engineering change ${ec.id} is ${ec.status}; only OPEN ECs can be approved`);
  }

  const approvedAt = new Date().toISOString();
  const updated = await prisma.engineeringChange.update({
    where: { id: ec.id, version: ec.version },
    data: { status: "APPROVED", approvedAt, version: { increment: 1 } },
  });
  await emit({
    ref: "#/domainEvents/EngineeringChangeApproved",
    aggregateId: updated.id,
    role,
    payload: { id: updated.id, approvedAt },
  });
  return updated;
}
