// Shared platform/control-plane types.
//
// These model the spec's identity + authorization vocabulary
// (multi-tenant-platform-spec.md §5–§6). A `Principal` is the resolved actor in
// an authorization decision; a `TenantContext` is the per-request tenant binding
// the AuthN layer derives from the authenticated identity (NEVER from client
// input — see §11 invariant #1).

/** An actor in an authorization decision (§5). */
export type PrincipalType = "identity" | "group" | "service_account";

export interface Principal {
  id: string;
  type: PrincipalType;
}

/** An AUTHENTICATED request binding. The identity is always established (a valid
 * session / dev shim), but `organizationId` may be ABSENT: a caller who is signed
 * in but not yet a member of any organization (e.g. a fresh superadmin, or a user
 * whose last membership was removed) carries an identity-only context from which
 * the ONLY meaningful action is creating their first org. Org-scoped work narrows
 * to TenantContext via requireTenant(). */
export interface RequestContext {
  principal: Principal;
  /** The human identity behind the principal (when principal.type === "identity"). */
  identityId?: string;
  /** The IdP subject the request authenticated as (audit/diagnostics). */
  subject?: string;
  /** The bound organization, once the request resolves to one. Absent ⇒ the
   * identity-only state above. DERIVED from a verified OrganizationMembership
   * (or platform-admin break-glass) — never read from client input. */
  organizationId?: string;
  /** The active workflow within the org (from X-Workflow-Id, validated in-org;
   * defaults to the org's "Default" workflow). Scopes the live model + data. */
  workflowId?: string;
  /** This identity holds a global platform-admin grant (superuser). */
  isPlatformAdmin?: boolean;
  /** This request entered a NON-member org via platform-admin break-glass (§10).
   * Set only when a platform admin selects an org they are not a member of; every
   * action under it is audited to the target org. Drives the PDP override. */
  actingAsPlatformAdmin?: boolean;
}

/** A request bound to a specific organization. `organizationId` is DERIVED from a
 * verified OrganizationMembership and is the single source of org truth
 * downstream. Obtained via requireTenant(), which fails closed when no org is
 * bound — so org-scoped handlers can never run identity-only. */
export interface TenantContext extends RequestContext {
  organizationId: string;
}

/** The permission lattice (§6.2): administer ⊇ edit ⊇ view; deploy is env-only. */
export type Permission = "view" | "edit" | "administer" | "deploy";

/** Where a role assignment / resource hangs in the containment tree (§6.2). */
export type ScopeType = "organization" | "environment" | "workspace" | "workflow" | "resource";

/** Built-in role keys (§6.3). Custom roles (Phase 2) are additional keys. */
export type BuiltinRoleKey = "owner" | "editor" | "viewer" | "deployer" | "org_admin";
