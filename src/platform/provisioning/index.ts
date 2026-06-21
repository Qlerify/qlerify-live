// Provisioning & lifecycle (spec §10 Provisioning Orchestrator, pooled-only).
//
// Two jobs:
//  1. seedSystemOrg() — idempotent boot seed. Creates the SYSTEM tenant and folds
//     the existing on-disk workflow.json (+ overlay.json) in as its ontology's
//     version 0. This is what lets the single-tenant demo keep running once
//     tenancy exists: header-less requests authenticate as the system identity
//     and resolve to the system org, so the demo flows THROUGH the spine.
//  2. createOrganization()/createEnvironment()/… — provision a NEW tenant:
//     org + registry row (pooled, local stack) + dev/prod environments + a
//     default workspace/project + an owner role assignment, all audited.
//
// These run in the CONTROL plane (it "knows all tenants", §10), so they use the
// Prisma client directly rather than the tenant-scoped store — you cannot be
// "inside" an org you are in the act of creating.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { QLERIFY_DIR } from "../../ontology/model.js";
import { hashPassword } from "../authn/sessions.js";
import { recordAudit } from "../audit/index.js";
import {
  SYSTEM_CUSTOMER_ACCOUNT_ID,
  SYSTEM_ENV_ID,
  SYSTEM_IDENTITY_ID,
  SYSTEM_ONTOLOGY_ID,
  SYSTEM_ONTOLOGY_RESOURCE_ID,
  SYSTEM_ORG_ID,
  SYSTEM_PROJECT_ID,
  SYSTEM_STACK_ID,
  SYSTEM_SUBJECT,
  SYSTEM_WORKSPACE_ID,
  newId,
  slugify,
} from "../ids.js";
import type { BuiltinRoleKey, PrincipalType, ScopeType } from "../types.js";
import { createVersion, ensureOntologyResource } from "../ontology-store/ontology-store.js";

const BUILTIN_ROLES: BuiltinRoleKey[] = ["owner", "editor", "viewer", "deployer", "org_admin"];
const STABLE_SYSTEM_ONTOLOGY_NAME = "workflow"; // one ontology slot, versioned over swaps

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

export async function createProject(organizationId: string, workspaceId: string, name: string, ownerId: string) {
  const ws = await prisma.platWorkspace.findFirst({ where: { id: workspaceId, organizationId } });
  if (!ws) throw new DomainError(`workspace "${workspaceId}" not found in this organization`);
  const proj = await prisma.platProject.create({ data: { id: newId(), organizationId, workspaceId, name } });
  await recordAudit({ organizationId, actorPrincipalId: ownerId, action: "project.create", targetRef: `project:${proj.id}`, decision: "allow", reason: name });
  await cloneModelIntoProject(organizationId, proj.id, workspaceId, ownerId);
  return proj;
}

/** Clone the on-disk default model into a project as its own v0 so the project
 * runs immediately with its own copy. The SYSTEM default project is NOT cloned —
 * it reads the live .qlerify/workflow.json directly (the demo's byte-identical
 * path); every OTHER project is CAS-backed. */
async function cloneModelIntoProject(organizationId: string, projectId: string, workspaceId: string, ownerId: string): Promise<void> {
  const workflowPath = join(QLERIFY_DIR, "workflow.json");
  if (!existsSync(workflowPath)) return;
  const workflowBytes = readFileSync(workflowPath, "utf8");
  const overlayPath = join(QLERIFY_DIR, "overlay.json");
  const overlayBytes = existsSync(overlayPath) ? readFileSync(overlayPath, "utf8") : null;
  const { ontologyId } = await ensureOntologyResource({
    organizationId,
    projectId,
    workspaceId,
    environmentId: null,
    name: "workflow",
    ownerId,
  });
  await createVersion(organizationId, ontologyId, workflowBytes, overlayBytes, { source: "initial", createdBy: ownerId });
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
 * workspace/project + owner grant. Pooled tenancy on the local stack (§12). */
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

  // Environments + a default workspace/project under development.
  const devId = newId();
  await prisma.platEnvironment.create({ data: { id: devId, organizationId: orgId, name: "development", region: homeRegion } });
  await prisma.platEnvironment.create({ data: { id: newId(), organizationId: orgId, name: "production", region: homeRegion } });
  const wsId = newId();
  await prisma.platWorkspace.create({ data: { id: wsId, organizationId: orgId, environmentId: devId, name: "Default" } });
  const defaultProjectId = newId();
  await prisma.platProject.create({ data: { id: defaultProjectId, organizationId: orgId, workspaceId: wsId, name: "Default" } });

  const ownerId = p.ownerIdentityId ?? actorPrincipalId ?? undefined;
  if (ownerId) {
    await addMembership(ownerId, orgId);
    await assignRole({ organizationId: orgId, principalId: ownerId, principalType: "identity", roleKey: "owner", scopeType: "organization", scopeId: orgId, grantedBy: actorPrincipalId });
  }

  // The new org's Default project gets its own copy of the current model (CAS-backed).
  await cloneModelIntoProject(orgId, defaultProjectId, wsId, ownerId ?? SYSTEM_IDENTITY_ID);

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

/** Tenant Registry lookup (§10) — pooled/local in inc 1. */
export async function lookupTenant(organizationId: string) {
  return prisma.platTenantRegistry.findUnique({ where: { organizationId } });
}

let systemSeeded = false;

/** Idempotent: create the system tenant and fold the on-disk model in as its
 * ontology's version 0. Safe to call on every boot. */
export async function seedSystemOrg(): Promise<void> {
  if (systemSeeded) return;
  await ensureBuiltinRoles();

  await prisma.platCustomerAccount.upsert({
    where: { id: SYSTEM_CUSTOMER_ACCOUNT_ID },
    update: {},
    create: { id: SYSTEM_CUSTOMER_ACCOUNT_ID, name: "System" },
  });
  await prisma.platOrganization.upsert({
    where: { id: SYSTEM_ORG_ID },
    update: {},
    create: { id: SYSTEM_ORG_ID, customerAccountId: SYSTEM_CUSTOMER_ACCOUNT_ID, name: "System", slug: "system", homeRegion: "local" },
  });
  await prisma.platStack.upsert({
    where: { stackId: SYSTEM_STACK_ID },
    update: {},
    create: { stackId: SYSTEM_STACK_ID, region: "local", mode: "pooled", endpoints: "{}", status: "active" },
  });
  await prisma.platTenantRegistry.upsert({
    where: { organizationId: SYSTEM_ORG_ID },
    update: {},
    create: { organizationId: SYSTEM_ORG_ID, customerAccountId: SYSTEM_CUSTOMER_ACCOUNT_ID, tenancyMode: "pooled", homeRegion: "local", stackId: SYSTEM_STACK_ID, status: "active" },
  });
  await prisma.platEnvironment.upsert({
    where: { id: SYSTEM_ENV_ID },
    update: {},
    create: { id: SYSTEM_ENV_ID, organizationId: SYSTEM_ORG_ID, name: "development", region: "local" },
  });
  // production env (no fixed id needed)
  if (!(await prisma.platEnvironment.findFirst({ where: { organizationId: SYSTEM_ORG_ID, name: "production" } }))) {
    await prisma.platEnvironment.create({ data: { id: newId(), organizationId: SYSTEM_ORG_ID, name: "production", region: "local" } });
  }
  await prisma.platWorkspace.upsert({
    where: { id: SYSTEM_WORKSPACE_ID },
    update: {},
    create: { id: SYSTEM_WORKSPACE_ID, organizationId: SYSTEM_ORG_ID, environmentId: SYSTEM_ENV_ID, name: "Default" },
  });
  await prisma.platProject.upsert({
    where: { id: SYSTEM_PROJECT_ID },
    update: {},
    create: { id: SYSTEM_PROJECT_ID, organizationId: SYSTEM_ORG_ID, workspaceId: SYSTEM_WORKSPACE_ID, name: "Default" },
  });

  // The system identity the demo authenticates as, + its membership + owner grant.
  await prisma.platIdentity.upsert({
    where: { subject: SYSTEM_SUBJECT },
    update: {},
    create: { id: SYSTEM_IDENTITY_ID, subject: SYSTEM_SUBJECT, primaryEmail: null, status: "active" },
  });
  await addMembership(SYSTEM_IDENTITY_ID, SYSTEM_ORG_ID);
  await assignRole({
    organizationId: SYSTEM_ORG_ID,
    principalId: SYSTEM_IDENTITY_ID,
    principalType: "identity",
    roleKey: "owner",
    scopeType: "organization",
    scopeId: SYSTEM_ORG_ID,
    grantedBy: SYSTEM_IDENTITY_ID,
  });

  // Fold the on-disk model in as the system ontology's version 0 (the
  // .qlerify/history embryo, generalized into the multi-tenant store).
  const { ontologyId } = await ensureOntologyResource({
    organizationId: SYSTEM_ORG_ID,
    resourceId: SYSTEM_ONTOLOGY_RESOURCE_ID,
    ontologyId: SYSTEM_ONTOLOGY_ID,
    environmentId: SYSTEM_ENV_ID,
    workspaceId: SYSTEM_WORKSPACE_ID,
    name: STABLE_SYSTEM_ONTOLOGY_NAME,
    ownerId: SYSTEM_IDENTITY_ID,
  });
  const workflowPath = join(QLERIFY_DIR, "workflow.json");
  if (existsSync(workflowPath)) {
    const workflowBytes = readFileSync(workflowPath, "utf8");
    const overlayPath = join(QLERIFY_DIR, "overlay.json");
    const overlayBytes = existsSync(overlayPath) ? readFileSync(overlayPath, "utf8") : null;
    await createVersion(SYSTEM_ORG_ID, ontologyId, workflowBytes, overlayBytes, { source: "initial", createdBy: SYSTEM_IDENTITY_ID });
  }

  await seedSuperuser();
  systemSeeded = true;
}

export const SUPERADMIN_SUBJECT = "superadmin";

/** Seed the superuser: a global platform-admin identity with a password, a
 * membership + owner role in the system org (its home), and credentials written
 * to a gitignored file for the operator. Password = SUPERADMIN_PASSWORD env, else
 * a default (change it). Re-applied each boot so the env override takes effect. */
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
  await addMembership(identity.id, SYSTEM_ORG_ID);
  await assignRole({
    organizationId: SYSTEM_ORG_ID,
    principalId: identity.id,
    principalType: "identity",
    roleKey: "owner",
    scopeType: "organization",
    scopeId: SYSTEM_ORG_ID,
    grantedBy: identity.id,
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
