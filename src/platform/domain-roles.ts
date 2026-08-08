// Domain-role mapping CRUD: "identity X plays model lane Y in workflow Z".
// This personalizes the To do surfaces (whoami.domainRoles, the "my roles"
// filter, the future digest's role → identities addressing). It is NOT an
// authorization construct — the PDP stays the security boundary; x-role stays
// the recorded-on-event domain role.

import { prisma } from "../db.js";
import { DomainError } from "../errors.js";

export interface DomainRoleAssignmentView {
  id: string;
  identityId: string;
  subject: string;
  domainRole: string;
  grantedAt: Date;
}

/** All lane assignments for one workflow, with the identity subjects resolved
 * for display. Org-scoped: a foreign workflowId simply returns []. */
export async function listDomainRoles(organizationId: string, workflowId: string): Promise<DomainRoleAssignmentView[]> {
  const rows = await prisma.platDomainRoleAssignment.findMany({
    where: { organizationId, workflowId },
    orderBy: [{ domainRole: "asc" }, { grantedAt: "asc" }],
  });
  const identities = await prisma.platIdentity.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.identityId))] } },
    select: { id: true, subject: true },
  });
  const subjectById = new Map(identities.map((i) => [i.id, i.subject]));
  return rows.map((r) => ({
    id: r.id,
    identityId: r.identityId,
    subject: subjectById.get(r.identityId) ?? r.identityId,
    domainRole: r.domainRole,
    grantedAt: r.grantedAt,
  }));
}

/** Grant a lane to a member. The identity must be a member of the org and the
 * workflow must belong to it (no cross-org grants). Idempotent: re-granting an
 * existing (workflow, identity, lane) triple returns the existing row. */
export async function assignDomainRole(input: {
  organizationId: string;
  workflowId: string;
  identityId: string;
  domainRole: string;
  grantedBy?: string;
}): Promise<{ id: string }> {
  const domainRole = input.domainRole.trim();
  if (!domainRole) throw new DomainError("domainRole is required");
  const workflow = await prisma.platWorkflow.findFirst({ where: { id: input.workflowId, organizationId: input.organizationId } });
  if (!workflow) throw new DomainError("workflow not found in this organization");
  const membership = await prisma.platOrgMembership.findFirst({
    where: { identityId: input.identityId, organizationId: input.organizationId, status: "active" },
  });
  if (!membership) throw new DomainError("member not found in this organization");
  const row = await prisma.platDomainRoleAssignment.upsert({
    where: {
      organizationId_workflowId_identityId_domainRole: {
        organizationId: input.organizationId,
        workflowId: input.workflowId,
        identityId: input.identityId,
        domainRole,
      },
    },
    update: {},
    create: {
      organizationId: input.organizationId,
      workflowId: input.workflowId,
      identityId: input.identityId,
      domainRole,
      grantedBy: input.grantedBy ?? null,
    },
  });
  return { id: row.id };
}

/** Remove one assignment by id, org-scoped: a foreign or unknown id throws
 * DomainError (422) — the control plane's not-found-in-org convention. */
export async function removeDomainRole(organizationId: string, id: string): Promise<void> {
  const { count } = await prisma.platDomainRoleAssignment.deleteMany({ where: { id, organizationId } });
  if (count === 0) throw new DomainError("assignment not found in this organization");
}

/** The lanes one identity plays in one workflow — whoami's domainRoles. */
export async function domainRolesFor(organizationId: string, workflowId: string, identityId: string): Promise<string[]> {
  const rows = await prisma.platDomainRoleAssignment.findMany({
    where: { organizationId, workflowId, identityId },
    select: { domainRole: true },
    orderBy: { domainRole: "asc" },
  });
  return rows.map((r) => r.domainRole);
}
