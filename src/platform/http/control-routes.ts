// Control-plane REST (spec §19), the subset that proves the increment-1 spine.
// Every handler runs inside the tenant context bound by the onRequest plugin;
// organization_id is taken from that resolved context (requireTenant()), never
// from the request body/path. Ontology endpoints prove org_id derives
// end-to-end: a cross-org id reads as 404 and a cross-org write is denied.

import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { AuthError, DomainError } from "../../errors.js";
import { recordAudit, verifyAuditChain } from "../audit/index.js";
import { isPlatformAdmin } from "../authn/index.js";
import { createSession, revokeSession, verifyPassword } from "../authn/sessions.js";
import { ensureAllowed } from "../authz.js";
import { newId, SYSTEM_ORG_ID, SYSTEM_PROJECT_ID } from "../ids.js";
import { authorize, resourceRef } from "../pdp/index.js";
import { ACTION_PERMISSION_MAP } from "../pdp/action-map.js";
import {
  addMembership,
  assignRole,
  createEnvironment,
  createOrganization,
  createProject,
  createWorkspace,
  ensureIdentity,
} from "../provisioning/index.js";
import { requireTenant } from "../tenancy/context.js";
import { setActiveProjectModel } from "../../twin/apply.js";
import { fetchSpecificationFromUrl } from "../../ontology/sync.js";
import {
  createVersion,
  currentContent,
  getOntologyById,
  listOntologies,
  listVersions,
} from "../ontology-store/ontology-store.js";
import type { PrincipalType, ScopeType, TenantContext } from "../types.js";

// --- Shared helpers ----------------------------------------------------------

/** Orgs the caller may see in the switcher: their member orgs, or ALL orgs for a
 * platform admin (org names are low-sensitivity control-plane metadata; a
 * non-admin is strictly membership-scoped so there is no cross-tenant oracle). */
async function accessibleOrgs(ctx: TenantContext) {
  const cols = { id: true, name: true, slug: true, homeRegion: true, status: true } as const;
  if (ctx.isPlatformAdmin) {
    return prisma.platOrganization.findMany({ select: cols, orderBy: { createdAt: "asc" } });
  }
  const memberships = await prisma.platOrgMembership.findMany({
    where: { identityId: ctx.identityId ?? "__none__", status: "active" },
    select: { organizationId: true },
  });
  return prisma.platOrganization.findMany({ where: { id: { in: memberships.map((m) => m.organizationId) } }, select: cols });
}

/** Gate a read on org-admin. Audits ONLY when the caller is a break-glass
 * platform admin (so normal admin reads don't spam the chain, but a superuser
 * peeking into another tenant always leaves a trail). */
async function assertOrgAdmin(ctx: TenantContext): Promise<void> {
  const resource = { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" as const };
  if (ctx.actingAsPlatformAdmin) {
    await ensureAllowed("organization.administer", resource, ctx); // audited break-glass read
    return;
  }
  const d = await authorize("organization.administer", resource, ctx);
  if (!d.allow) throw new AuthError(d.reason);
}

/** Re-validate a client-supplied filter id IS a row in the current org, returning
 * it or throwing — so an optional ?xId= filter can never widen past the tenant. */
async function inOrgOr404<T>(row: T | null, what: string): Promise<T> {
  if (!row) throw new DomainError(`${what} not found in this organization`);
  return row;
}

function fail(reply: any, err: unknown) {
  const status = typeof (err as any)?.status === "number" ? (err as any).status : 500;
  const code = (err as any)?.code ?? "INTERNAL";
  return reply.code(status).send({ error: code, message: (err as Error).message });
}

export function registerControlRoutes(app: FastifyInstance) {
  // Who am I — the derived tenant context + the orgs I can switch to. The tenant
  // bar reads this once to render the whole shell.
  app.get("/v1/whoami", async (req, reply) => {
    try {
      const ctx = requireTenant();
      return {
        organizationId: ctx.organizationId,
        principal: ctx.principal,
        subject: ctx.subject,
        isPlatformAdmin: !!ctx.isPlatformAdmin,
        actingAsPlatformAdmin: !!ctx.actingAsPlatformAdmin,
        organizations: await accessibleOrgs(ctx),
        projectId: ctx.projectId,
        isSystemProject: ctx.projectId === SYSTEM_PROJECT_ID,
        // The org's projects, readable by any member (for the breadcrumb picker).
        projects: await prisma.platProject.findMany({
          where: { organizationId: ctx.organizationId },
          select: { id: true, name: true },
          orderBy: { createdAt: "asc" },
        }),
      };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Auth (login / logout) ----------------------------------------------
  // Login runs header-less (system context) and does its OWN password check —
  // it never reads requireTenant() for the credential. Uniform 401 (no user
  // enumeration); both branches pay the scrypt cost.
  app.post("/v1/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { subject?: string; password?: string };
    const subject = (body.subject ?? "").trim();
    const password = body.password ?? "";
    const identity = subject ? await prisma.platIdentity.findUnique({ where: { subject } }) : null;
    // Always run scrypt (even for an unknown / passwordless subject) so login
    // timing never reveals whether an account exists. Passwordless identities
    // (e.g. `system`) can never be logged into.
    const pwOk = verifyPassword(password, identity?.passwordHash ?? null);
    const ok = !!identity && identity.status === "active" && !!identity.passwordHash && pwOk;
    if (!ok || !identity) {
      await recordAudit({ organizationId: SYSTEM_ORG_ID, action: "auth.login", decision: "deny", reason: `failed login for "${subject}"` });
      return reply.code(401).send({ error: "AUTH_ERROR", message: "invalid username or password" });
    }
    const { token } = await createSession(identity.id, new Date());
    await recordAudit({ organizationId: SYSTEM_ORG_ID, actorPrincipalId: identity.id, action: "auth.login", decision: "allow", reason: `login "${subject}"` });
    const ctxLike = { organizationId: SYSTEM_ORG_ID, principal: { id: identity.id, type: "identity" as const }, identityId: identity.id, isPlatformAdmin: await isPlatformAdmin(identity.id) };
    return {
      token,
      identity: { id: identity.id, subject: identity.subject, isPlatformAdmin: ctxLike.isPlatformAdmin },
      organizations: await accessibleOrgs(ctxLike as any),
    };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    try {
      const auth = (req.headers["authorization"] as string) || "";
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (m) await revokeSession(m[1].trim(), new Date());
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Tenant lifecycle ----------------------------------------------------
  // Self-service provisioning: the caller becomes owner of the new org.
  app.post("/v1/organizations", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { name?: string; homeRegion?: string };
      if (!body.name) throw new DomainError("name is required");
      const org = await createOrganization({ name: body.name, homeRegion: body.homeRegion, ownerIdentityId: ctx.identityId }, ctx.principal.id);
      return reply.code(201).send(org);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Orgs the caller can switch to (member orgs, or all orgs for a platform admin).
  app.get("/v1/organizations", async (req, reply) => {
    try {
      return await accessibleOrgs(requireTenant());
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/environments", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { name?: string; region?: string };
      if (!body.name) throw new DomainError("name is required");
      // Creating infra in an org requires administering it.
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const env = await createEnvironment(ctx.organizationId, body.name, body.region ?? "local");
      return reply.code(201).send(env);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Identity & access ---------------------------------------------------
  app.post("/v1/memberships", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { subject?: string; email?: string };
      if (!body.subject) throw new DomainError("subject is required");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const identity = await ensureIdentity(body.subject, body.email ?? null);
      const membership = await addMembership(identity.id, ctx.organizationId);
      return reply.code(201).send({ identityId: identity.id, organizationId: ctx.organizationId, membershipId: membership.id });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/role-assignments", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as {
        principalId?: string;
        principalType?: PrincipalType;
        roleKey?: string;
        scopeType?: ScopeType;
        scopeId?: string;
      };
      if (!body.principalId || !body.roleKey || !body.scopeType || !body.scopeId) {
        throw new DomainError("principalId, roleKey, scopeType, scopeId are required");
      }
      // Granting access requires administer on the target scope (§6.4).
      await ensureAllowed("organization.administer", { id: body.scopeId, organizationId: ctx.organizationId, scopeType: body.scopeType }, ctx);
      const a = await assignRole({
        organizationId: ctx.organizationId,
        principalId: body.principalId,
        principalType: body.principalType ?? "identity",
        roleKey: body.roleKey,
        scopeType: body.scopeType,
        scopeId: body.scopeId,
        grantedBy: ctx.principal.id,
      });
      return reply.code(201).send({ id: a.id });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Decision endpoint (§19, internal) -----------------------------------
  app.post("/v1/authorize", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { action?: string; resourceId?: string };
      if (!body.action || !body.resourceId) throw new DomainError("action and resourceId are required");
      if (!(body.action in ACTION_PERMISSION_MAP)) throw new DomainError(`unknown action "${body.action}"`);
      const resource = await prisma.platResource.findFirst({ where: { id: body.resourceId, organizationId: ctx.organizationId } });
      // A resource in another org (or missing) → DENY by boundary, never leaked.
      if (!resource) return { allow: false, reason: "resource not found in this organization" };
      const decision = await authorize(body.action, resourceRef(resource), ctx);
      return decision;
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Ontology-as-resource (§16) — the resource proving org_id end-to-end --
  app.get("/v1/ontologies", async (req, reply) => {
    try {
      const ctx = requireTenant();
      return await listOntologies(ctx.organizationId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/ontologies/:id", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as any).id as string;
      const ont = await getOntologyById(ctx.organizationId, id); // scoped → null for other orgs
      if (!ont) return reply.code(404).send({ error: "NOT_FOUND", message: "ontology not found" });
      await ensureAllowed("ontology.read", { id: ont.resourceId, organizationId: ctx.organizationId, scopeType: "resource", environmentId: ont.environmentId, workspaceId: ont.workspaceId, projectId: null }, ctx);
      const versions = await listVersions(ctx.organizationId, ont.id);
      return { id: ont.id, name: ont.name, resourceId: ont.resourceId, currentVersionId: ont.currentVersionId, versions };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/ontologies/:id/content", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as any).id as string;
      const ont = await getOntologyById(ctx.organizationId, id);
      if (!ont) return reply.code(404).send({ error: "NOT_FOUND", message: "ontology not found" });
      await ensureAllowed("ontology.read", { id: ont.resourceId, organizationId: ctx.organizationId, scopeType: "resource", environmentId: ont.environmentId, workspaceId: ont.workspaceId, projectId: null }, ctx);
      const content = await currentContent(ctx.organizationId, ont.id);
      if (!content) return reply.code(404).send({ error: "NOT_FOUND", message: "no version content" });
      return content;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put("/v1/ontologies/:id/content", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as any).id as string;
      const body = (req.body ?? {}) as { workflow?: string; overlay?: string | null; source?: string };
      if (typeof body.workflow !== "string") throw new DomainError("workflow (string) is required");
      const ont = await getOntologyById(ctx.organizationId, id);
      if (!ont) return reply.code(404).send({ error: "NOT_FOUND", message: "ontology not found" });
      // Writing a new version requires `edit` on the ontology resource.
      await ensureAllowed("ontology.write", { id: ont.resourceId, organizationId: ctx.organizationId, scopeType: "resource", environmentId: ont.environmentId, workspaceId: ont.workspaceId, projectId: null }, ctx);
      const result = await createVersion(ctx.organizationId, ont.id, body.workflow, body.overlay ?? null, { source: body.source ?? "edit", createdBy: ctx.principal.id });
      return reply.code(result.changed ? 201 : 200).send(result);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Audit (§17) ---------------------------------------------------------
  app.get("/v1/audit/verify", async (req, reply) => {
    try {
      const ctx = requireTenant();
      return await verifyAuditChain(ctx.organizationId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Admin read surface (org-admin gated, org-scoped) -------------------
  app.get("/v1/members", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await assertOrgAdmin(ctx);
      const memberships = await prisma.platOrgMembership.findMany({ where: { organizationId: ctx.organizationId } });
      const identities = await prisma.platIdentity.findMany({
        where: { id: { in: memberships.map((m) => m.identityId) } },
        select: { id: true, subject: true, primaryEmail: true, status: true },
      });
      const assignments = await prisma.platRoleAssignment.findMany({
        where: { organizationId: ctx.organizationId, principalType: "identity" },
        select: { principalId: true, roleKey: true },
      });
      const rolesByPrincipal: Record<string, Set<string>> = {};
      for (const a of assignments) (rolesByPrincipal[a.principalId] ??= new Set()).add(a.roleKey);
      const mstatus = Object.fromEntries(memberships.map((m) => [m.identityId, m.status]));
      return identities.map((i) => ({
        identityId: i.id,
        subject: i.subject,
        primaryEmail: i.primaryEmail,
        status: mstatus[i.id] ?? i.status,
        roles: [...(rolesByPrincipal[i.id] ?? [])],
      }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/role-assignments", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await assertOrgAdmin(ctx);
      return prisma.platRoleAssignment.findMany({
        where: { organizationId: ctx.organizationId },
        select: { id: true, principalId: true, principalType: true, roleKey: true, scopeType: true, scopeId: true, grantedAt: true },
        orderBy: { grantedAt: "desc" },
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/markings", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await assertOrgAdmin(ctx);
      return prisma.platMarking.findMany({
        where: { organizationId: ctx.organizationId },
        select: { id: true, name: true, description: true, createdAt: true },
        orderBy: { name: "asc" },
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/markings", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { name?: string; description?: string };
      if (!body.name) throw new DomainError("name is required");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const m = await prisma.platMarking.create({ data: { id: newId(), organizationId: ctx.organizationId, name: body.name, description: body.description ?? null } });
      return reply.code(201).send({ id: m.id, name: m.name });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/environments", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await assertOrgAdmin(ctx);
      return prisma.platEnvironment.findMany({
        where: { organizationId: ctx.organizationId },
        select: { id: true, name: true, region: true, lifecycleState: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/workspaces", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await assertOrgAdmin(ctx);
      const envId = (req.query as any)?.environmentId as string | undefined;
      if (envId) await inOrgOr404(await prisma.platEnvironment.findFirst({ where: { id: envId, organizationId: ctx.organizationId } }), "environment");
      return prisma.platWorkspace.findMany({
        where: { organizationId: ctx.organizationId, ...(envId ? { environmentId: envId } : {}) },
        select: { id: true, name: true, environmentId: true, lifecycleState: true },
        orderBy: { createdAt: "asc" },
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/projects", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await assertOrgAdmin(ctx);
      const wsId = (req.query as any)?.workspaceId as string | undefined;
      if (wsId) await inOrgOr404(await prisma.platWorkspace.findFirst({ where: { id: wsId, organizationId: ctx.organizationId } }), "workspace");
      return prisma.platProject.findMany({
        where: { organizationId: ctx.organizationId, ...(wsId ? { workspaceId: wsId } : {}) },
        select: { id: true, name: true, workspaceId: true, lifecycleState: true },
        orderBy: { createdAt: "asc" },
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/v1/audit", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await assertOrgAdmin(ctx);
      const limit = Math.min(200, Math.max(1, Number((req.query as any)?.limit ?? 50)));
      return prisma.platAuditEvent.findMany({
        where: { organizationId: ctx.organizationId, streamId: ctx.organizationId },
        orderBy: { seq: "desc" },
        take: limit,
        select: { seq: true, action: true, decision: true, actorPrincipalId: true, targetRef: true, reason: true, occurredAt: true },
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Workspace / Project creation (org-admin gated) ---------------------
  app.post("/v1/workspaces", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { name?: string; environmentId?: string };
      if (!body.name || !body.environmentId) throw new DomainError("name and environmentId are required");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const ws = await createWorkspace(ctx.organizationId, body.environmentId, body.name);
      return reply.code(201).send({ id: ws.id, name: ws.name, environmentId: ws.environmentId });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/v1/projects", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { name?: string; workspaceId?: string };
      if (!body.name || !body.workspaceId) throw new DomainError("name and workspaceId are required");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const proj = await createProject(ctx.organizationId, body.workspaceId, body.name, ctx.principal.id);
      return reply.code(201).send({ id: proj.id, name: proj.name, workspaceId: proj.workspaceId });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Set the ACTIVE (non-system) project's own model from a Qlerify workflow.json.
  // Stores a new version + rebuilds ONLY this project's data plane (system + other
  // projects untouched). Org-admin gated.
  app.put("/v1/project/model", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { workflow?: string; overlay?: string | null; sourceUrl?: string };
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      // Primary path: a Qlerify modeller link → pull the latest model via MCP.
      let workflow = body.workflow;
      if (body.sourceUrl && body.sourceUrl.trim()) {
        try {
          workflow = await fetchSpecificationFromUrl(body.sourceUrl.trim());
        } catch (e: any) {
          return reply.code(502).send({ error: "FETCH_FAILED", message: e?.message ?? String(e) });
        }
      }
      // Secondary path: pasted / uploaded workflow.json text.
      if (typeof workflow !== "string" || !workflow.trim()) {
        throw new DomainError("Provide a Qlerify model link, or upload/paste a workflow.json");
      }
      const result = await setActiveProjectModel(workflow, body.overlay ?? null);
      return { ok: true, ...result };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
