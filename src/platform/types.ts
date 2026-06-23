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

/** The per-request tenant binding. `organizationId` is DERIVED from a verified
 * OrganizationMembership and is the single source of org truth downstream. */
export interface TenantContext {
  organizationId: string;
  principal: Principal;
  /** The human identity behind the principal (when principal.type === "identity"). */
  identityId?: string;
  /** The IdP subject the request authenticated as (audit/diagnostics). */
  subject?: string;
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

/** The permission lattice (§6.2): administer ⊇ edit ⊇ view; deploy is env-only. */
export type Permission = "view" | "edit" | "administer" | "deploy";

/** Where a role assignment / resource hangs in the containment tree (§6.2). */
export type ScopeType = "organization" | "environment" | "workspace" | "workflow" | "resource";

/** Built-in role keys (§6.3). Custom roles (Phase 2) are additional keys. */
export type BuiltinRoleKey = "owner" | "editor" | "viewer" | "deployer" | "org_admin";
