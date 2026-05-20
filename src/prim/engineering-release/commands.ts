import { prisma } from "../../db.js";
import { assertRole, type Role } from "../../auth.js";
import { emit } from "../../events/bus.js";
import { DomainError } from "../../errors.js";
import { requireString } from "../../util/invariants.js";

export interface ApproveEngineeringReleaseArgs {
  projectId: string;
}

export async function approveEngineeringRelease(args: ApproveEngineeringReleaseArgs, role: Role) {
  assertRole(role, "Configuration Manager");
  requireString("projectId", args.projectId);

  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    include: { bomItems: true },
  });
  if (!project) throw new DomainError(`project ${args.projectId} does not exist`);
  const notDs2 = project.bomItems.filter((i) => i.designState !== "DS2_PROD");
  if (notDs2.length > 0) {
    throw new DomainError(`engineering release blocked: ${notDs2.length} bom items not at DS2_PROD`);
  }

  const approvedAt = new Date().toISOString();
  const er = await prisma.engineeringRelease.upsert({
    where: { projectId: project.id },
    create: { projectId: project.id, status: "APPROVED", approvedAt },
    update: { status: "APPROVED", approvedAt, version: { increment: 1 } },
  });

  await emit({
    ref: "#/domainEvents/EngineeringReleaseApproved",
    aggregateId: er.id,
    role,
    payload: { id: er.id, projectId: project.id, approvedAt },
  });
  return er;
}
