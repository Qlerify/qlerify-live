// AuthN: resolve a request's credentials into a TenantContext (spec §11).
//
// The security-critical invariant lives here: organization_id is DERIVED from a
// verified, active OrganizationMembership — never read from a client header,
// body, or path. A caller MAY pass X-Org-Id / X-Org-Slug to SELECT which org;
// that value only INDEXES the membership lookup, the canonical organization_id
// is the membership row's org.
//
// Credential resolution, in order:
//   1. Bearer <opaque session token>  (from /v1/auth/login) — the real path.
//   2. Bearer <subject> / X-Identity-Subject — the forgeable DEV SHIM, allowed
//      ONLY for non-privileged identities (no password, no platform-admin grant).
//      A credentialed or superuser identity can NEVER be impersonated this way —
//      it must present a real session token. This closes the "one env var = a
//      forgeable god-token" hole the red-team flagged.
//   3. No credentials ⇒ REJECTED. There is no header-less demo default: every
//      request must authenticate. The SYSTEM org remains control-plane plumbing
//      (superuser home, non-request fallback, audit anchor) — never a login.
//
// Platform admin (superuser, §10): may SELECT an org it is not a member of
// (break-glass); the request is flagged actingAsPlatformAdmin and audited at
// first authorized use. Selection is widened, derivation is not — the canonical
// org is still the selected org's row.

import { prisma } from "../../db.js";
import { AuthError, UnauthenticatedError } from "../../errors.js";
import type { RequestContext } from "../types.js";
import { resolveSession } from "./sessions.js";

export interface AuthnHeaders {
  authorization?: string;
  "x-identity-subject"?: string;
  "x-org-id"?: string;
  "x-org-slug"?: string;
  [k: string]: string | string[] | undefined;
}

function header(headers: AuthnHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function bearer(headers: AuthnHeaders): string | undefined {
  const auth = header(headers, "authorization");
  if (!auth) return undefined;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

type Identity = { id: string; subject: string; status: string; passwordHash: string | null };

/** Does this identity hold a global platform-admin (superuser) grant? */
export async function isPlatformAdmin(identityId: string): Promise<boolean> {
  return !!(await prisma.platPlatformAdmin.findUnique({ where: { identityId } }));
}

/** A credentialed or superuser identity must use a real session — never the
 * forgeable raw-subject dev shim. */
async function devSubjectAllowed(identity: Identity): Promise<boolean> {
  if (identity.passwordHash) return false;
  if (await isPlatformAdmin(identity.id)) return false;
  return true;
}

async function resolveIdentity(headers: AuthnHeaders): Promise<{ identity: Identity; subject: string }> {
  const tok = bearer(headers);
  if (tok) {
    // (1) Opaque session token.
    const identityId = await resolveSession(tok, new Date());
    if (identityId) {
      const identity = await prisma.platIdentity.findUnique({ where: { id: identityId } });
      if (!identity || identity.status !== "active") throw new UnauthenticatedError("session identity is not active");
      return { identity, subject: identity.subject };
    }
    // (2) Raw-subject dev shim — non-privileged identities only.
    const identity = await prisma.platIdentity.findUnique({ where: { subject: tok } });
    if (!identity) throw new UnauthenticatedError("invalid or expired credential");
    if (identity.status !== "active") throw new UnauthenticatedError(`identity "${tok}" is not active`);
    if (!(await devSubjectAllowed(identity))) throw new UnauthenticatedError("this account requires sign-in");
    return { identity, subject: identity.subject };
  }

  // (3) X-Identity-Subject dev shim (non-privileged identities only). No
  // credentials at all ⇒ reject: there is no header-less demo default — every
  // request must authenticate (org → workspace → workflow starts at sign-in).
  const sub = header(headers, "x-identity-subject");
  if (!sub) throw new UnauthenticatedError("authentication required");
  const identity = await prisma.platIdentity.findUnique({ where: { subject: sub } });
  if (!identity) throw new UnauthenticatedError(`unknown identity subject: ${sub}`);
  if (identity.status !== "active") throw new UnauthenticatedError(`identity "${sub}" is not active`);
  if (!(await devSubjectAllowed(identity))) throw new UnauthenticatedError("this account requires sign-in");
  return { identity, subject: sub };
}

/** Resolve request headers into the request context, or throw on an auth failure.
 * Returns an ORG-bound context when the identity resolves to an organization, or
 * an IDENTITY-ONLY context (no organizationId) when the authenticated caller is a
 * member of no org and selected none — from which the only meaningful action is
 * creating their first org. There is no system-org default: org-scoped routes
 * fail closed on an identity-only context (requireTenant throws). */
export async function resolveTenantContext(headers: AuthnHeaders): Promise<RequestContext> {
  const { identity, subject } = await resolveIdentity(headers);
  const platformAdmin = await isPlatformAdmin(identity.id);

  const memberships = await prisma.platOrgMembership.findMany({
    where: { identityId: identity.id, status: "active" },
  });
  const selector = header(headers, "x-org-id") ?? header(headers, "x-org-slug");

  const base: RequestContext = {
    principal: { id: identity.id, type: "identity" },
    identityId: identity.id,
    subject,
    isPlatformAdmin: platformAdmin,
  };

  let organizationId: string | undefined;
  let actingAsPlatformAdmin = false;

  if (selector) {
    const memberOrgIds = memberships.map((m) => m.organizationId);
    const memberOrgs = memberOrgIds.length
      ? await prisma.platOrganization.findMany({ where: { id: { in: memberOrgIds } } })
      : [];
    const memberMatch = memberOrgs.find((o) => o.id === selector || o.slug === selector);
    if (memberMatch) {
      organizationId = memberMatch.id; // normal: a member-selected org
    } else if (platformAdmin) {
      // Break-glass: a platform admin may enter an org it is not a member of.
      const any = await prisma.platOrganization.findFirst({ where: { OR: [{ id: selector }, { slug: selector }] } });
      if (!any) throw new AuthError(`organization "${selector}" not found`);
      organizationId = any.id;
      actingAsPlatformAdmin = true;
    } else {
      // Fail CLOSED: the canonical org is never taken from a non-member selector.
      // A stale/invalid X-Org-Id (e.g. a deleted org left in the client's
      // localStorage) is recovered CLIENT-side — the UI drops it and retries
      // without the selector (see ensureMe()) — so this denial can't lock anyone out.
      throw new AuthError(`identity "${subject}" is not a member of organization "${selector}"`);
    }
  } else if (memberships.length === 1) {
    organizationId = memberships[0].organizationId;
  } else if (memberships.length === 0) {
    // Authenticated but in no org yet (a fresh superadmin, a self-service caller,
    // or a user whose last membership was removed). Identity-only context: the
    // caller can create their first org; every org-scoped route fails closed.
    return base;
  } else {
    throw new AuthError(`identity "${subject}" belongs to multiple organizations — specify X-Org-Id`);
  }

  const org = await prisma.platOrganization.findUnique({ where: { id: organizationId } });
  if (!org) throw new AuthError("organization not found");
  if (org.status !== "active") throw new AuthError(`organization "${org.slug}" is ${org.status}`);

  // Active workflow: validated to be a workflow in THIS org (never trusted as a raw
  // id). An invalid / cross-org / stale selector falls back to the org's "Default"
  // workflow rather than failing the request — the client never gets a workflow it
  // didn't legitimately select, but a stale picker value can't lock anyone out.
  const workflowSelector = header(headers, "x-workflow-id");
  let workflowId: string | undefined;
  if (workflowSelector) {
    const proj = await prisma.platWorkflow.findFirst({ where: { id: workflowSelector, organizationId: org.id }, select: { id: true } });
    workflowId = proj?.id;
  }
  if (!workflowId) {
    // Land on the org's "Default" workflow when present, else its oldest. If the org
    // has NO workflows (a fresh org, or its last was deleted), leave workflowId UNSET
    // — the empty-org state: the control plane (whoami / create-workflow) still
    // works, but the data plane fails closed (NoActiveWorkflowError → 409) until the
    // user creates a workflow and points it at a model.
    const def =
      (await prisma.platWorkflow.findFirst({ where: { organizationId: org.id, name: "Default" }, orderBy: { createdAt: "asc" }, select: { id: true } })) ??
      (await prisma.platWorkflow.findFirst({ where: { organizationId: org.id }, orderBy: { createdAt: "asc" }, select: { id: true } }));
    workflowId = def?.id; // undefined ⇒ empty org
  }

  return {
    ...base,
    organizationId: org.id, // canonical — the membership/org row, not the raw header
    workflowId,
    ...(actingAsPlatformAdmin ? { actingAsPlatformAdmin: true } : {}),
  };
}
