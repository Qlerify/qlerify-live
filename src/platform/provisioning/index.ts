// Provisioning & lifecycle (spec §10 Provisioning Orchestrator, pooled-only).
//
// Two jobs:
//  1. seedPlatform() — idempotent boot seed. Ensures the built-in roles and the
//     superuser (a global platform-admin identity, member of NO org), and removes
//     a legacy seeded system org left by older builds. There is no system
//     organization: a fresh install has ZERO orgs, and the superuser signs in and
//     creates the first one.
//  2. createOrganization()/createEnvironment()/… — provision a NEW tenant:
//     org + registry row (pooled, local stack) + dev/prod environments + a
//     default workspace (but ZERO workflows) + an owner role assignment, audited.
//
// These run in the CONTROL plane (it "knows all tenants", §10), so they use the
// Prisma client directly rather than the tenant-scoped store — you cannot be
// "inside" an org you are in the act of creating.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { QLERIFY_DIR, forgetWorkflowModel } from "../../ontology/model.js";
import { dropProjectionTablesForWorkflow } from "../../twin/projection-store.js";
import { hashPassword } from "../authn/sessions.js";
import { recordAudit } from "../audit/index.js";
import { SYSTEM_ORG_ID, SYSTEM_STACK_ID, SYSTEM_WORKFLOW_ID, newId, slugify } from "../ids.js";
import type { BuiltinRoleKey, PrincipalType, ScopeType } from "../types.js";

const BUILTIN_ROLES: BuiltinRoleKey[] = ["owner", "editor", "viewer", "deployer", "org_admin"];

function titleCase(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_m, _p, c) => " " + c.toUpperCase()).trim();
}

/** Seed the built-in roles (org-agnostic). findFirst-or-create avoids the
 * SQLite nullable-unique pitfall (NULLs compare distinct). */
async function ensureBuiltinRoles(): Promise<void> {
  for (const key of BUILTIN_ROLES) {
    const e = await prisma.platRole.findFirst({ where: { organizationId: null, key } });
    if (!e) await prisma.platRole.create({ data: { id: newId(), organizationId: null, key, name: titleCase(key), builtin: true } });
  }
}

export interface RoleAssignmentInput {
  organizationId: string;
  principalId: string;
  principalType: PrincipalType;
  roleKey: string;
  scopeType: ScopeType;
  scopeId: string;
  grantedBy?: string | null;
}

/** Idempotent role grant (the source-of-record that projects into ReBAC, §6.3). */
export async function assignRole(a: RoleAssignmentInput) {
  const existing = await prisma.platRoleAssignment.findFirst({
    where: {
      organizationId: a.organizationId,
      principalId: a.principalId,
      principalType: a.principalType,
      roleKey: a.roleKey,
      scopeType: a.scopeType,
      scopeId: a.scopeId,
    },
  });
  if (existing) return existing;
  const created = await prisma.platRoleAssignment.create({
    data: {
      id: newId(),
      organizationId: a.organizationId,
      principalId: a.principalId,
      principalType: a.principalType,
      roleKey: a.roleKey,
      scopeType: a.scopeType,
      scopeId: a.scopeId,
      grantedBy: a.grantedBy ?? null,
    },
  });
  await recordAudit({
    organizationId: a.organizationId,
    actorPrincipalId: a.grantedBy ?? null,
    action: "role.assign",
    targetRef: `${a.scopeType}:${a.scopeId}`,
    decision: "allow",
    reason: `${a.roleKey} → ${a.principalType}:${a.principalId}`,
  });
  return created;
}

/** Upsert a global identity by IdP subject (§5 — identities are NOT org-scoped). */
export async function ensureIdentity(subject: string, primaryEmail?: string | null) {
  return prisma.platIdentity.upsert({
    where: { subject },
    update: {},
    create: { id: newId(), subject, primaryEmail: primaryEmail ?? null },
  });
}

/** Idempotent membership grant (§5 — the join that grants org access). */
export async function addMembership(identityId: string, organizationId: string) {
  const existing = await prisma.platOrgMembership.findFirst({ where: { identityId, organizationId } });
  if (existing) return existing;
  const created = await prisma.platOrgMembership.create({
    data: { id: newId(), identityId, organizationId, status: "active" },
  });
  await recordAudit({
    organizationId,
    actorPrincipalId: null,
    action: "membership.add",
    targetRef: `identity:${identityId}`,
    decision: "allow",
  });
  return created;
}

export async function createEnvironment(organizationId: string, name: string, region = "local") {
  const env = await prisma.platEnvironment.create({ data: { id: newId(), organizationId, name, region } });
  await recordAudit({ organizationId, action: "environment.create", targetRef: `environment:${env.id}`, decision: "allow", reason: name });
  return env;
}

export async function createWorkspace(organizationId: string, environmentId: string, name: string) {
  // The composite FK guarantees the environment is same-org; validate first for a
  // clean error instead of a raw FK violation.
  const env = await prisma.platEnvironment.findFirst({ where: { id: environmentId, organizationId } });
  if (!env) throw new DomainError(`environment "${environmentId}" not found in this organization`);
  const ws = await prisma.platWorkspace.create({ data: { id: newId(), organizationId, environmentId, name } });
  await recordAudit({ organizationId, action: "workspace.create", targetRef: `workspace:${ws.id}`, decision: "allow", reason: name });
  return ws;
}

export async function createWorkflow(organizationId: string, workspaceId: string, name: string, ownerId: string) {
  const ws = await prisma.platWorkspace.findFirst({ where: { id: workspaceId, organizationId } });
  if (!ws) throw new DomainError(`workspace "${workspaceId}" not found in this organization`);
  const proj = await prisma.platWorkflow.create({ data: { id: newId(), organizationId, workspaceId, name } });
  await recordAudit({ organizationId, actorPrincipalId: ownerId, action: "workflow.create", targetRef: `workflow:${proj.id}`, decision: "allow", reason: name });
  // A new workflow starts with NO model — the user points it at their own Qlerify
  // model via PUT /v1/workflow/model. Nothing is cloned/preloaded.
  return proj;
}

/** Delete a workflow and CASCADE-drop everything it owns: its raw-SQL projection
 * tables (gen__p<workflow>_*) and their data, its EventLog run history, and its
 * control-plane metadata (ontology + versions + branches, resources + markings,
 * workflow-scoped role assignments, and the workflow row itself). Then new tables
 * are built lazily the next time a (different) workflow's model is applied.
 *
 * The virtual SYSTEM workflow id is refused (defense-in-depth) — it is never a
 * real, deletable workflow row.
 *
 * Deliberately NOT touched here:
 *  - Adapters/connectors. They are global (not workflow-scoped) today and are
 *    AI-authored/throwaway; their lifecycle is handled separately.
 *  - Content-addressed model blobs in the CAS. They are write-once and may be
 *    DEDUPED across this org's workflows (two workflows pointed at the same model
 *    share a hash), so deleting them could corrupt a sibling workflow. They are
 *    left as harmless orphans (CAS GC is a separate, org-level concern). */
export async function deleteWorkflow(
  organizationId: string,
  workflowId: string,
  actorPrincipalId: string,
): Promise<{ id: string; droppedTables: string[]; droppedModels: number }> {
  if (workflowId === SYSTEM_WORKFLOW_ID) {
    throw new DomainError("The system default workflow cannot be deleted.");
  }
  const proj = await prisma.platWorkflow.findFirst({
    where: { id: workflowId, organizationId },
    select: { id: true, name: true },
  });
  if (!proj) throw new DomainError(`workflow "${workflowId}" not found in this organization`);

  // Ontology + resource ids owned by this workflow drive the metadata cascade.
  const onts = await prisma.platOntology.findMany({ where: { organizationId, workflowId }, select: { id: true } });
  const ontologyIds = onts.map((o) => o.id);
  const resources = await prisma.platResource.findMany({ where: { organizationId, workflowId }, select: { id: true } });
  const resourceIds = resources.map((r) => r.id);

  // Atomically remove the workflow's metadata + run history. FK-safe order:
  // versions/branches → ontology → resource markings → resource → grants →
  // workflow. Deleting the PlatWorkflow row in the SAME commit means a stale
  // X-Workflow-Id can never resolve back to it (authn validates the id in-org and
  // falls back to Default when the row is gone) — so the model self-heal can't
  // resurrect an orphan.
  await prisma.$transaction([
    prisma.platOntologyVersion.deleteMany({ where: { organizationId, ontologyId: { in: ontologyIds } } }),
    prisma.platOntologyBranch.deleteMany({ where: { organizationId, ontologyId: { in: ontologyIds } } }),
    prisma.platOntology.deleteMany({ where: { organizationId, workflowId } }),
    prisma.platResourceMarking.deleteMany({ where: { organizationId, resourceId: { in: resourceIds } } }),
    prisma.platResource.deleteMany({ where: { organizationId, workflowId } }),
    prisma.platRoleAssignment.deleteMany({ where: { organizationId, scopeType: "workflow", scopeId: workflowId } }),
    prisma.eventLog.deleteMany({ where: { organizationId, workflowId } }),
    prisma.platWorkflow.deleteMany({ where: { id: workflowId, organizationId } }),
  ]);

  // Drop the physical projection tables AFTER the metadata commit: a failure here
  // can only orphan now-invisible tables, never leave a half-listed workflow.
  const droppedTables = await dropProjectionTablesForWorkflow(workflowId);

  // Evict the workflow's live model from the in-memory loader caches.
  forgetWorkflowModel(workflowId);

  await recordAudit({
    organizationId,
    actorPrincipalId,
    action: "workflow.delete",
    targetRef: `workflow:${workflowId}`,
    decision: "allow",
    reason: `deleted workflow "${proj.name}" — dropped ${droppedTables.length} table(s), ${ontologyIds.length} model(s)`,
  });

  return { id: workflowId, droppedTables, droppedModels: ontologyIds.length };
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  let n = 1;
  while (await prisma.platOrganization.findUnique({ where: { slug } })) slug = `${base}-${++n}`;
  return slug;
}

export interface CreateOrgParams {
  name: string;
  customerAccountId?: string;
  homeRegion?: string;
  /** Identity to make org owner (e.g. the requesting admin). */
  ownerIdentityId?: string;
}

/** Provision a new organization: org + registry + dev/prod envs + default
 * workspace/workflow + owner grant. Pooled tenancy on the local stack (§12). */
export async function createOrganization(p: CreateOrgParams, actorPrincipalId?: string | null) {
  await ensureBuiltinRoles();
  const homeRegion = p.homeRegion ?? "local";

  const customerAccountId =
    p.customerAccountId ?? (await prisma.platCustomerAccount.create({ data: { id: newId(), name: p.name } })).id;

  const slug = await uniqueSlug(p.name);
  const orgId = newId();
  await prisma.platOrganization.create({
    data: { id: orgId, customerAccountId, name: p.name, slug, homeRegion, status: "active" },
  });

  // Tenant registry — pooled mode, single local stack (one org / one region).
  await prisma.platStack.upsert({
    where: { stackId: SYSTEM_STACK_ID },
    update: {},
    create: { stackId: SYSTEM_STACK_ID, region: "local", mode: "pooled", endpoints: "{}", status: "active" },
  });
  await prisma.platTenantRegistry.create({
    data: { organizationId: orgId, customerAccountId, tenancyMode: "pooled", homeRegion, stackId: SYSTEM_STACK_ID, status: "active" },
  });

  // Environments + a default workspace. NO workflow is created: a fresh org starts
  // empty (zero workflows) and lands on the empty-org screen, where the owner
  // creates their first workflow and points it at their own Qlerify model.
  const devId = newId();
  await prisma.platEnvironment.create({ data: { id: devId, organizationId: orgId, name: "development", region: homeRegion } });
  await prisma.platEnvironment.create({ data: { id: newId(), organizationId: orgId, name: "production", region: homeRegion } });
  const wsId = newId();
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: devId, name: "Default" } });

  const ownerId = p.ownerIdentityId ?? actorPrincipalId ?? undefined;
  if (ownerId) {
    await addMembership(ownerId, orgId);
    await assignRole({ organizationId: orgId, principalId: ownerId, principalType: "identity", roleKey: "owner", scopeType: "organization", scopeId: orgId, grantedBy: actorPrincipalId });
  }

  await recordAudit({
    organizationId: orgId,
    actorPrincipalId: actorPrincipalId ?? null,
    action: "organization.create",
    targetRef: `organization:${orgId}`,
    decision: "allow",
    reason: `provisioned org "${slug}" (pooled/${homeRegion})`,
  });

  return { id: orgId, slug, customerAccountId, homeRegion, environments: { developmentId: devId }, workspaceId: wsId };
}

/** Rename an organization. Only the display name changes — the slug is a stable
 * routing/lookup handle and is deliberately left untouched. */
export async function updateOrganization(
  organizationId: string,
  patch: { name?: string },
  actorPrincipalId?: string | null,
) {
  const org = await prisma.platOrganization.findUnique({ where: { id: organizationId } });
  if (!org) throw new DomainError("organization not found");
  const name = (patch.name ?? "").trim();
  if (!name) throw new DomainError("name is required");
  if (name === org.name) return { id: org.id, name: org.name, slug: org.slug, homeRegion: org.homeRegion, status: org.status };

  const updated = await prisma.platOrganization.update({ where: { id: organizationId }, data: { name } });
  await recordAudit({
    organizationId,
    actorPrincipalId: actorPrincipalId ?? null,
    action: "organization.update",
    targetRef: `organization:${organizationId}`,
    decision: "allow",
    reason: `renamed "${org.name}" → "${name}"`,
  });
  return { id: updated.id, name: updated.name, slug: updated.slug, homeRegion: updated.homeRegion, status: updated.status };
}

/** Delete an organization and CASCADE everything it owns. Irreversible.
 *
 * Order: (1) delete every workflow via deleteWorkflow() — that drops each workflow's
 * physical projection tables (gen__p*), event-log run history, and workflow-scoped
 * model/resource graph; then (2) atomically delete the remaining org-scoped
 * control-plane rows (org-level ontologies/resources, memberships, roles,
 * markings, groups, service accounts, envs/workspaces, tenant registry, the org's
 * audit chain) in FK-safe order, ending with the org row itself; then (3) drop the
 * org's dedicated customer account if no sibling org shares it.
 *
 * The deletion is audited under the platform stream (SYSTEM_ORG_ID — a sentinel,
 * not a row) because the org's own audit chain is removed in the cascade. */
export async function deleteOrganization(
  organizationId: string,
  actorPrincipalId: string,
): Promise<{ id: string; deletedWorkflows: number; droppedTables: number }> {
  const org = await prisma.platOrganization.findUnique({ where: { id: organizationId } });
  if (!org) throw new DomainError("organization not found");

  // (1) Workflows first — each call drops that workflow's physical tables + history.
  const workflows = await prisma.platWorkflow.findMany({ where: { organizationId }, select: { id: true } });
  let droppedTables = 0;
  for (const p of workflows) {
    const r = await deleteWorkflow(organizationId, p.id, actorPrincipalId);
    droppedTables += r.droppedTables.length;
  }

  // (2) The remaining org-level model graph + all flat org-scoped rows, atomically.
  // FK-safe order: ontology versions/branches → ontologies → resource markings →
  // resources; then the independent tables; workspaces before environments (the
  // workspace→environment composite FK); finally registry, audit, and the org row.
  const onts = await prisma.platOntology.findMany({ where: { organizationId }, select: { id: true } });
  const ontologyIds = onts.map((o) => o.id);

  await prisma.$transaction([
    prisma.platOntologyVersion.deleteMany({ where: { organizationId, ontologyId: { in: ontologyIds } } }),
    prisma.platOntologyBranch.deleteMany({ where: { organizationId, ontologyId: { in: ontologyIds } } }),
    prisma.platOntology.deleteMany({ where: { organizationId } }),
    prisma.platResourceMarking.deleteMany({ where: { organizationId } }),
    prisma.platResource.deleteMany({ where: { organizationId } }),
    prisma.eventLog.deleteMany({ where: { organizationId } }),
    prisma.platSharingGrant.deleteMany({ where: { organizationId } }),
    prisma.platMarkingGrant.deleteMany({ where: { organizationId } }),
    prisma.platMarking.deleteMany({ where: { organizationId } }),
    prisma.platRoleAssignment.deleteMany({ where: { organizationId } }),
    prisma.platRole.deleteMany({ where: { organizationId } }), // org-scoped custom roles only (builtins have a null org)
    prisma.platGroupMembership.deleteMany({ where: { organizationId } }),
    prisma.platGroup.deleteMany({ where: { organizationId } }),
    prisma.platServiceAccount.deleteMany({ where: { organizationId } }),
    prisma.platOrgMembership.deleteMany({ where: { organizationId } }),
    prisma.platWorkflow.deleteMany({ where: { organizationId } }), // belt-and-suspenders (already gone above)
    prisma.platWorkspace.deleteMany({ where: { organizationId } }),
    prisma.platEnvironment.deleteMany({ where: { organizationId } }),
    prisma.platTenantRegistry.deleteMany({ where: { organizationId } }),
    prisma.platAuditEvent.deleteMany({ where: { organizationId } }),
    prisma.platOrganization.deleteMany({ where: { id: organizationId } }),
  ]);

  // (3) The org's dedicated customer account — only if no other org references it.
  {
    const siblings = await prisma.platOrganization.count({ where: { customerAccountId: org.customerAccountId } });
    if (siblings === 0) await prisma.platCustomerAccount.deleteMany({ where: { id: org.customerAccountId } });
  }

  // Audited under the SYSTEM stream — the org's own chain was deleted above.
  await recordAudit({
    organizationId: SYSTEM_ORG_ID,
    actorPrincipalId,
    action: "organization.delete",
    targetRef: `organization:${organizationId}`,
    decision: "allow",
    reason: `deleted org "${org.slug}" — ${workflows.length} workflow(s), ${droppedTables} table(s)`,
  });

  return { id: organizationId, deletedWorkflows: workflows.length, droppedTables };
}

/** Tenant Registry lookup (§10) — pooled/local in inc 1. */
export async function lookupTenant(organizationId: string) {
  return prisma.platTenantRegistry.findUnique({ where: { organizationId } });
}

let platformSeeded = false;

/** Idempotent boot seed. Ensures the built-in roles + the superuser, and removes
 * any legacy seeded system org from older builds. There is NO system org: a fresh
 * install starts with zero orgs and the superuser creates the first one. Safe to
 * call on every boot. */
export async function seedPlatform(): Promise<void> {
  if (platformSeeded) return;
  await ensureBuiltinRoles();
  await removeLegacySystemOrg();
  await seedSuperuser();
  platformSeeded = true;
}

/** One-time removal of the retired system org (the fixed SYSTEM_ORG_ID) seeded by
 * older builds. It never held workflows or business data, so this just drops its
 * control-plane rows + the legacy "system" identity. Its audit events are LEFT in
 * place — SYSTEM_ORG_ID is now the platform audit stream, so the chain stays
 * intact. Idempotent: a no-op once the org is gone. */
async function removeLegacySystemOrg(): Promise<void> {
  const org = await prisma.platOrganization.findUnique({ where: { id: SYSTEM_ORG_ID } });
  if (org) {
    await prisma.$transaction([
      prisma.platRoleAssignment.deleteMany({ where: { organizationId: SYSTEM_ORG_ID } }),
      prisma.platOrgMembership.deleteMany({ where: { organizationId: SYSTEM_ORG_ID } }),
      prisma.platWorkspace.deleteMany({ where: { organizationId: SYSTEM_ORG_ID } }),
      prisma.platEnvironment.deleteMany({ where: { organizationId: SYSTEM_ORG_ID } }),
      prisma.platTenantRegistry.deleteMany({ where: { organizationId: SYSTEM_ORG_ID } }),
      prisma.platOrganization.deleteMany({ where: { id: SYSTEM_ORG_ID } }),
    ]);
    // The shared system customer account, if now unreferenced.
    if ((await prisma.platOrganization.count({ where: { customerAccountId: org.customerAccountId } })) === 0) {
      await prisma.platCustomerAccount.deleteMany({ where: { id: org.customerAccountId } });
    }
  }
  // The legacy passwordless "system" identity + any dangling grants/memberships —
  // independent of the org row, since an earlier boot may have removed the org but
  // left the identity behind.
  const sys = await prisma.platIdentity.findUnique({ where: { subject: "system" } });
  if (sys) {
    await prisma.platRoleAssignment.deleteMany({ where: { principalId: sys.id } });
    await prisma.platOrgMembership.deleteMany({ where: { identityId: sys.id } });
    await prisma.platIdentity.deleteMany({ where: { id: sys.id } });
  }
}

export const SUPERADMIN_SUBJECT = "superadmin";

/** Seed the superuser: a global platform-admin identity with a password and NO org
 * membership — it is platform-scoped, not a tenant member (it reaches orgs via
 * break-glass, and owns the orgs it creates). Credentials are written to a
 * gitignored file for the operator. Password = SUPERADMIN_PASSWORD env, else a
 * default (change it). Re-applied each boot so the env override takes effect. */
async function seedSuperuser(): Promise<void> {
  const password = process.env.SUPERADMIN_PASSWORD || "superadmin";
  const identity = await prisma.platIdentity.upsert({
    where: { subject: SUPERADMIN_SUBJECT },
    update: { passwordHash: hashPassword(password) },
    create: { id: newId(), subject: SUPERADMIN_SUBJECT, primaryEmail: null, status: "active", passwordHash: hashPassword(password) },
  });
  await prisma.platPlatformAdmin.upsert({
    where: { identityId: identity.id },
    update: {},
    create: { identityId: identity.id },
  });
  try {
    writeFileSync(
      join(QLERIFY_DIR, "superadmin.local.txt"),
      `Qlerify Platform — superuser account\nusername: ${SUPERADMIN_SUBJECT}\npassword: ${password}\n\n(Set SUPERADMIN_PASSWORD to override. Change this before any non-firewalled deployment.)\n`,
    );
  } catch {
    /* best-effort — the account still works regardless of the file */
  }
}
