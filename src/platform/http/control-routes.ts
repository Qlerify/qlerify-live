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
import { createSession, hashPassword, revokeSession, verifyPassword } from "../authn/sessions.js";
import { loginRateLimiter } from "../authn/rate-limit.js";
import { ensureAllowed } from "../authz.js";
import { newId, SYSTEM_ORG_ID } from "../ids.js";
import { authorize, resourceRef } from "../pdp/index.js";
import { ACTION_PERMISSION_MAP } from "../pdp/action-map.js";
import {
  addMembership,
  assignRole,
  createEnvironment,
  createOrganization,
  createWorkflow,
  createWorkspace,
  deleteOrganization,
  deleteWorkflow,
  ensureIdentity,
  issueMemberCredential,
  setOrgAnthropicConfig,
  setOrgQlerifyConfig,
  updateOrganization,
} from "../provisioning/index.js";
import { resolveAnthropicStatus } from "../../llm/anthropic.js";
import { resolveQlerifyStatus } from "../../llm/qlerify.js";
import { requireIdentity, requireTenant, runWithTenant } from "../tenancy/context.js";
import { applyWorkflowModel } from "../../twin/apply.js";
import { fetchSpecificationFromUrl } from "../../ontology/sync.js";
import {
  createVersion,
  currentContent,
  getOntologyById,
  getVersionContent,
  getWorkflowOntology,
  listOntologies,
  listVersions,
} from "../ontology-store/ontology-store.js";
import type { PrincipalType, RequestContext, ScopeType, TenantContext } from "../types.js";

// --- Shared helpers ----------------------------------------------------------

/** Orgs the caller may see in the switcher: their member orgs, or ALL orgs for a
 * platform admin (org names are low-sensitivity control-plane metadata; a
 * non-admin is strictly membership-scoped so there is no cross-tenant oracle). */
async function accessibleOrgs(ctx: RequestContext) {
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

/** A Qlerify link couldn't be pulled — distinct from a bad/invalid model (400) so
 * the client can tell "your link/network failed" from "your model is wrong". */
class FetchError extends Error {
  readonly code = "FETCH_FAILED";
  readonly status = 502;
}

interface ModelInputBody {
  workflow?: string;
  overlay?: string | null;
  sourceUrl?: string;
}

/** Resolve the workflow.json text for a model-setting request: pull from a Qlerify
 * modeller link (sourceUrl) when given, else use the uploaded/pasted workflow text.
 * Throws FetchError (→502) on a bad/unreachable link, DomainError (→400) when no
 * model is provided at all. The returned sourceUrl (null for upload/paste) is
 * recorded on the version so a later "reload" can re-pull. */
async function resolveModelInput(body: ModelInputBody): Promise<{ workflow: string; overlay: string | null; sourceUrl: string | null }> {
  const sourceUrl = body.sourceUrl && body.sourceUrl.trim() ? body.sourceUrl.trim() : null;
  let workflow = body.workflow;
  if (sourceUrl) {
    try {
      workflow = await fetchSpecificationFromUrl(sourceUrl);
    } catch (e: any) {
      // A missing/invalid Qlerify key is a configuration problem, not a fetch
      // failure — let its DomainError surface as-is (422 + "add a key in
      // Organisation admin") instead of being masked as a generic 502.
      if (e instanceof DomainError) throw e;
      throw new FetchError(e?.message ?? String(e));
    }
  }
  if (typeof workflow !== "string" || !workflow.trim()) {
    throw new DomainError("Provide a Qlerify model link, or upload/paste a workflow.json");
  }
  return { workflow, overlay: body.overlay ?? null, sourceUrl };
}

export function registerControlRoutes(app: FastifyInstance) {
  // Who am I — the derived tenant context + the orgs I can switch to. The tenant
  // bar reads this once to render the whole shell.
  app.get("/v1/whoami", async (req, reply) => {
    try {
      const ctx = requireIdentity();
      // Surfaced so a reload (not just the login response) re-gates a member who
      // still owes a password change into the change-password screen.
      const idRow = ctx.identityId ? await prisma.platIdentity.findUnique({ where: { id: ctx.identityId }, select: { mustChangePassword: true } }) : null;
      const common = {
        principal: ctx.principal,
        subject: ctx.subject,
        isPlatformAdmin: !!ctx.isPlatformAdmin,
        actingAsPlatformAdmin: !!ctx.actingAsPlatformAdmin,
        mustChangePassword: !!idRow?.mustChangePassword,
        organizations: await accessibleOrgs(ctx),
      };
      // Authenticated but not a member of any org yet (fresh superadmin, or a user
      // whose last membership was removed) → the shell shows "create your first
      // organisation". No org-scoped data is available.
      if (!ctx.organizationId) {
        return { ...common, organizationId: null, workflowId: null, workflows: [] };
      }
      return {
        ...common,
        organizationId: ctx.organizationId,
        workflowId: ctx.workflowId ?? null,
        // The org's workflows, readable by any member (for the breadcrumb picker).
        workflows: await prisma.platWorkflow.findMany({
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
    const ip = req.ip || "unknown";

    // Rate limit BEFORE any DB/scrypt work — a throttled attacker can't even probe.
    const gate = loginRateLimiter.check(ip, subject);
    if (gate.blocked) {
      await recordAudit({ organizationId: SYSTEM_ORG_ID, action: "auth.login", decision: "deny", reason: `rate-limited login for "${subject}"` });
      reply.header("Retry-After", String(gate.retryAfterSec));
      return reply.code(429).send({ error: "RATE_LIMITED", message: "too many sign-in attempts — try again later" });
    }

    const identity = subject ? await prisma.platIdentity.findUnique({ where: { subject } }) : null;
    // Always run scrypt (even for an unknown / passwordless subject) so login
    // timing never reveals whether an account exists. Passwordless identities
    // (e.g. `system`) can never be logged into.
    const pwOk = verifyPassword(password, identity?.passwordHash ?? null);
    const ok = !!identity && identity.status === "active" && !!identity.passwordHash && pwOk;
    if (!ok || !identity) {
      loginRateLimiter.recordFailure(ip, subject);
      await recordAudit({ organizationId: SYSTEM_ORG_ID, action: "auth.login", decision: "deny", reason: `failed login for "${subject}"` });
      return reply.code(401).send({ error: "AUTH_ERROR", message: "invalid username or password" });
    }
    loginRateLimiter.recordSuccess(ip, subject); // a real sign-in clears this subject's throttle
    const { token } = await createSession(identity.id, new Date());
    await recordAudit({ organizationId: SYSTEM_ORG_ID, actorPrincipalId: identity.id, action: "auth.login", decision: "allow", reason: `login "${subject}"` });
    const ctxLike = { organizationId: SYSTEM_ORG_ID, principal: { id: identity.id, type: "identity" as const }, identityId: identity.id, isPlatformAdmin: await isPlatformAdmin(identity.id) };
    return {
      token,
      // The client gates a must-change member into the change-password screen.
      identity: { id: identity.id, subject: identity.subject, isPlatformAdmin: ctxLike.isPlatformAdmin, mustChangePassword: identity.mustChangePassword },
      organizations: await accessibleOrgs(ctxLike as any),
    };
  });

  // Self-service password change (authenticated — NOT under /v1/auth/*, so the
  // tenant plugin binds the caller's identity first). Verifies the current
  // password, sets a new one, clears the must-change flag, and rotates sessions:
  // every other session for this identity is revoked and a fresh token issued, so
  // a temp password that may have been seen by an admin (or a leaked old session)
  // is dead the moment the member sets their own.
  app.post("/v1/account/password", async (req, reply) => {
    try {
      const ctx = requireIdentity();
      const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
      const current = body.currentPassword ?? "";
      const next = (body.newPassword ?? "").trim();
      if (next.length < 10) throw new DomainError("new password must be at least 10 characters");
      const identity = await prisma.platIdentity.findUnique({ where: { id: ctx.identityId } });
      // 403 (not 401): the SESSION is valid, only the supplied current password is
      // wrong — a 401 would make the client's api() wrapper force a full sign-out.
      if (!identity || !verifyPassword(current, identity.passwordHash ?? null)) {
        throw new AuthError("current password is incorrect");
      }
      if (verifyPassword(next, identity.passwordHash)) throw new DomainError("new password must differ from the current one");
      await prisma.platIdentity.update({ where: { id: identity.id }, data: { passwordHash: hashPassword(next), mustChangePassword: false } });
      // Kill all existing sessions for this identity, then mint a fresh one so the
      // caller stays signed in on this device with a token the old password can't reach.
      await prisma.platSession.updateMany({ where: { identityId: identity.id, revokedAt: null }, data: { revokedAt: new Date() } });
      const { token } = await createSession(identity.id, new Date());
      await recordAudit({ organizationId: SYSTEM_ORG_ID, actorPrincipalId: identity.id, action: "identity.password.change", targetRef: `identity:${identity.id}`, decision: "allow", reason: "member changed their own password" });
      return { ok: true, token };
    } catch (err) {
      return fail(reply, err);
    }
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
      const ctx = requireIdentity();
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

  // Rename the current org (display name only — the slug stays stable). Destructive
  // to nothing; still org-admin gated, and you can only edit the org you're in.
  app.patch("/v1/organizations/:id", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as { id: string }).id;
      if (id !== ctx.organizationId) throw new DomainError("you can only modify the organization you are signed into");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const body = (req.body ?? {}) as { name?: string };
      return await updateOrganization(ctx.organizationId, { name: body.name }, ctx.principal.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Per-org Anthropic account (BYOK). The masked status only — never the key.
  app.get("/v1/organizations/:id/anthropic-config", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as { id: string }).id;
      if (id !== ctx.organizationId) throw new DomainError("you can only read the organization you are signed into");
      await assertOrgAdmin(ctx);
      return await resolveAnthropicStatus();
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Set or clear the current org's own Anthropic key + optional model override.
  // Org-admin gated; validate-on-save rejects a bad key; response is masked.
  app.put("/v1/organizations/:id/anthropic-config", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as { id: string }).id;
      if (id !== ctx.organizationId) throw new DomainError("you can only modify the organization you are signed into");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const body = (req.body ?? {}) as { apiKey?: string; model?: string; clear?: boolean };
      return await setOrgAnthropicConfig(ctx.organizationId, body, ctx.principal.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Per-org Qlerify account (BYOK) — the credential used to fetch a model behind
  // "Reload from link". The masked status only — never the key.
  app.get("/v1/organizations/:id/qlerify-config", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as { id: string }).id;
      if (id !== ctx.organizationId) throw new DomainError("you can only read the organization you are signed into");
      await assertOrgAdmin(ctx);
      return await resolveQlerifyStatus();
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Set or clear the current org's own Qlerify key. The MCP endpoint is fixed (the
  // platform default), so there is no URL to set. Org-admin gated; validate-on-save
  // rejects a bad key; response is masked.
  app.put("/v1/organizations/:id/qlerify-config", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as { id: string }).id;
      if (id !== ctx.organizationId) throw new DomainError("you can only modify the organization you are signed into");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const body = (req.body ?? {}) as { apiKey?: string; clear?: boolean };
      return await setOrgQlerifyConfig(ctx.organizationId, body, ctx.principal.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Delete the current org and CASCADE everything it owns. Irreversible →
  // org-admin gated; the system org and a cross-org id are refused.
  app.delete("/v1/organizations/:id", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const id = (req.params as { id: string }).id;
      if (id !== ctx.organizationId) throw new DomainError("you can only delete the organization you are signed into");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const result = await deleteOrganization(ctx.organizationId, ctx.principal.id);
      return { ok: true, ...result };
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
      // A member needs a credential to sign in (the dev shim is off in prod). Mint a
      // one-time password ONLY when this identity has none yet — if they already have
      // one (already a member elsewhere, or re-invited), don't reset it; they keep
      // their existing credential and just gain this membership.
      const temporaryPassword = identity.passwordHash ? undefined : await issueMemberCredential(identity.id, ctx.organizationId, ctx.principal.id);
      const membership = await addMembership(identity.id, ctx.organizationId);
      // temporaryPassword is returned to the admin EXACTLY once (to convey out-of-band);
      // it is never stored in the clear nor audited.
      return reply.code(201).send({ identityId: identity.id, organizationId: ctx.organizationId, membershipId: membership.id, temporaryPassword });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Admin reset: re-issue a one-time password for a member of THIS org (org-admin
  // gated). The only recovery path with no email/SSO flow. Returns the plaintext
  // once; the member must change it on next sign-in.
  app.post("/v1/members/:id/reset-password", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const identityId = (req.params as { id: string }).id;
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      // The target must be a member of the caller's org — never reset an identity
      // you can't see (no cross-org credential reset).
      const membership = await prisma.platOrgMembership.findFirst({ where: { identityId, organizationId: ctx.organizationId } });
      if (!membership) throw new DomainError("member not found in this organization");
      const temporaryPassword = await issueMemberCredential(identityId, ctx.organizationId, ctx.principal.id);
      return { ok: true, identityId, temporaryPassword };
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
      await ensureAllowed("ontology.read", { id: ont.resourceId, organizationId: ctx.organizationId, scopeType: "resource", environmentId: ont.environmentId, workspaceId: ont.workspaceId, workflowId: null }, ctx);
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
      await ensureAllowed("ontology.read", { id: ont.resourceId, organizationId: ctx.organizationId, scopeType: "resource", environmentId: ont.environmentId, workspaceId: ont.workspaceId, workflowId: null }, ctx);
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
      await ensureAllowed("ontology.write", { id: ont.resourceId, organizationId: ctx.organizationId, scopeType: "resource", environmentId: ont.environmentId, workspaceId: ont.workspaceId, workflowId: null }, ctx);
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

  app.get("/v1/workflows", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await assertOrgAdmin(ctx);
      const wsId = (req.query as any)?.workspaceId as string | undefined;
      if (wsId) await inOrgOr404(await prisma.platWorkspace.findFirst({ where: { id: wsId, organizationId: ctx.organizationId } }), "workspace");
      return prisma.platWorkflow.findMany({
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

  // --- Workspace / Workflow creation (org-admin gated) ---------------------
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

  // Create a workflow WITH its model in one atomic step — an empty, model-less
  // workflow can never exist. The model is resolved first (a bad link fails before
  // anything is created); the workflow row is then created and the model applied to
  // it (bound via runWithTenant since the new workflow isn't the active one). If the
  // model is invalid, the just-created workflow is rolled back so no orphan remains.
  app.post("/v1/workflows", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const body = (req.body ?? {}) as { name?: string; workspaceId?: string } & ModelInputBody;
      if (!body.name || !body.workspaceId) throw new DomainError("name and workspaceId are required");
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);

      // Resolve (and, for a link, fetch) the model BEFORE creating anything — a bad
      // link/network 502s here and leaves no workflow behind.
      const { workflow, overlay, sourceUrl } = await resolveModelInput(body);

      const proj = await createWorkflow(ctx.organizationId, body.workspaceId, body.name, ctx.principal.id);
      try {
        await runWithTenant({ ...ctx, workflowId: proj.id }, () =>
          applyWorkflowModel(workflow, overlay, { source: "set", sourceUrl }),
        );
      } catch (applyErr) {
        // Atomicity: a model that won't load must not leave a model-less workflow.
        await deleteWorkflow(ctx.organizationId, proj.id, ctx.principal.id).catch(() => {});
        throw applyErr;
      }
      return reply.code(201).send({ id: proj.id, name: proj.name, workspaceId: proj.workspaceId });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Delete a workflow and cascade-drop its data plane + model metadata. Destructive
  // → org-admin gated (same as creation; §6.4 maps deletion to `administer`). The
  // system default workflow is refused by deleteWorkflow().
  app.delete("/v1/workflows/:id", async (req, reply) => {
    try {
      const ctx = requireTenant();
      const workflowId = (req.params as { id: string }).id;
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const result = await deleteWorkflow(ctx.organizationId, workflowId, ctx.principal.id);
      return { ok: true, ...result };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Re-point the ACTIVE (non-system) workflow at a model (link, or uploaded/pasted
  // workflow.json) — e.g. to change the link. Stores a new version + rebuilds ONLY
  // this workflow's data plane (system + other workflows untouched). Org-admin gated.
  app.put("/v1/workflow/model", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const { workflow, overlay, sourceUrl } = await resolveModelInput((req.body ?? {}) as ModelInputBody);
      const result = await applyWorkflowModel(workflow, overlay, { source: "set", sourceUrl });
      return { ok: true, ...result };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Version history for the ACTIVE workflow's model: the list (oldest→newest) plus
  // which one is current and the effective reload link. Shape mirrors what the
  // Inspect-model dialog's version sidebar renders. Empty when no model yet.
  app.get("/v1/workflow/model/status", async (req, reply) => {
    try {
      const ctx = requireTenant();
      if (!ctx.workflowId) return { versions: [], current: -1, total: 0, currentVersion: null, sourceUrl: null };
      const ont = await getWorkflowOntology(ctx.organizationId, ctx.workflowId);
      if (!ont) return { versions: [], current: -1, total: 0, currentVersion: null, sourceUrl: null };
      const rows = await listVersions(ctx.organizationId, ont.id);
      const versions = rows.map((v) => ({
        id: v.id,
        seq: v.seq,
        source: v.source,
        sourceUrl: v.sourceUrl,
        sourceName: v.sourceName,
        savedAt: v.createdAt,
        summary: v.summaryJson ? JSON.parse(v.summaryJson) : { events: 0, roles: 0, boundedContexts: 0 },
      }));
      const current = versions.findIndex((v) => v.id === ont.currentVersionId);
      const currentVersion = current >= 0 ? versions[current] : null;
      // The reload source is the current version's link (the model the workflow is
      // pointed at right now); null when it came from an upload/paste.
      return { versions, current, total: versions.length, currentVersion, sourceUrl: currentVersion?.sourceUrl ?? null };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // The active workflow's CURRENT model body (workflow.json text) — for the
  // Inspect dialog's read-only viewer. 404 when the workflow has no model yet.
  app.get("/v1/workflow/model/content", async (req, reply) => {
    try {
      const ctx = requireTenant();
      if (!ctx.workflowId) return reply.code(404).send({ error: "NOT_FOUND", message: "no active workflow" });
      const ont = await getWorkflowOntology(ctx.organizationId, ctx.workflowId);
      if (!ont) return reply.code(404).send({ error: "NOT_FOUND", message: "this workflow has no model yet" });
      const content = await currentContent(ctx.organizationId, ont.id);
      if (!content) return reply.code(404).send({ error: "NOT_FOUND", message: "no version content" });
      return { content: content.workflow, overlay: content.overlay };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Restore a stored version: re-apply its exact content as a NEW current version
  // (source "restore", carrying its original link forward) and rebuild this
  // workflow's data plane. History stays linear — restore never rewrites the past.
  app.post("/v1/workflow/model/restore", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      const body = (req.body ?? {}) as { versionId?: string };
      if (!body.versionId) throw new DomainError("versionId is required");
      if (!ctx.workflowId) throw new DomainError("Select a workflow first.");
      const ont = await getWorkflowOntology(ctx.organizationId, ctx.workflowId);
      if (!ont) return reply.code(404).send({ error: "NOT_FOUND", message: "this workflow has no model yet" });
      // The version must belong to THIS workflow's ontology (deny cross-workflow ids).
      const row = await prisma.platOntologyVersion.findFirst({
        where: { id: body.versionId, organizationId: ctx.organizationId, ontologyId: ont.id },
        select: { id: true, sourceUrl: true },
      });
      if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "version not found for this workflow" });
      const content = await getVersionContent(ctx.organizationId, row.id);
      if (!content) return reply.code(404).send({ error: "NOT_FOUND", message: "version content missing" });
      const result = await applyWorkflowModel(content.workflow, content.overlay, { source: "restore", sourceUrl: row.sourceUrl });
      return { ok: true, ...result };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Reload: re-pull the latest model from the current version's stored Qlerify link
  // and apply it as a new version (source "fetch"). Unavailable (409) when the
  // current model came from an upload/paste, since there's no link to re-pull.
  app.post("/v1/workflow/model/reload", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await ensureAllowed("organization.administer", { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" }, ctx);
      if (!ctx.workflowId) throw new DomainError("Select a workflow first.");
      const ont = await getWorkflowOntology(ctx.organizationId, ctx.workflowId);
      if (!ont?.currentVersionId) return reply.code(404).send({ error: "NOT_FOUND", message: "this workflow has no model yet" });
      const cur = await prisma.platOntologyVersion.findFirst({
        where: { id: ont.currentVersionId, organizationId: ctx.organizationId },
        select: { sourceUrl: true },
      });
      if (!cur?.sourceUrl) throw new DomainError("This model has no source link to reload — it was uploaded or pasted. Re-point it via Set model.");
      let workflow: string;
      try {
        workflow = await fetchSpecificationFromUrl(cur.sourceUrl);
      } catch (e: any) {
        // Config problem (no Qlerify key/URL) → surface its DomainError verbatim;
        // only a real transport/HTTP failure becomes a 502 FetchError.
        if (e instanceof DomainError) throw e;
        throw new FetchError(e?.message ?? String(e));
      }
      const result = await applyWorkflowModel(workflow, null, { source: "fetch", sourceUrl: cur.sourceUrl });
      return { ok: true, ...result };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
