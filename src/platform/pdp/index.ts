// Policy Decision Point (spec §6) — the embedded ReBAC + MAC evaluator.
//
// This is the Phase-1 adjustment: NOT an external Zanzibar engine (SpiceDB /
// OpenFGA / Keto), but a relational evaluator that computes the SAME decision
// flow directly over the SQL tables the spec names as the system of record
// (§6.5). Because the SQL store IS the evaluation store, there is no derived
// index, no transactional outbox, and no consistency token — reads are
// automatically read-after-write. The decision flow (§6.1) and the action map
// (§6.4) are pinned at this interface so an engine swap later does not change a
// single call site; adding SpiceDB is a named cost (outbox + ZedToken plumbing),
// not a config flip.
//
// Decision flow (§6.1), evaluated in order:
//   0. Tenant boundary  — resource.org === ctx.org, else DENY (defense in depth)
//   1. MAC gate         — caller must hold EVERY marking on the resource, else DENY
//   2. DAC (ReBAC)      — role/relationship check with containment inheritance
//
// MAC can only ever SUBTRACT access; a marking never grants anything.

import { prisma } from "../../db.js";
import { requireTenant } from "../tenancy/context.js";
import type { Permission, Principal, ScopeType, TenantContext } from "../types.js";
import { actionToPermission } from "./action-map.js";

/** The resource (or scope) an action targets, with its containment chain so the
 * PDP can walk `parent->permission` inheritance (§6.2). */
export interface AuthzResource {
  /** Resource id, or the scope id when authorizing a scope itself. */
  id: string;
  organizationId: string;
  /** Where this sits in the tree; defaults to "resource". */
  scopeType?: ScopeType;
  workflowId?: string | null;
  workspaceId?: string | null;
  environmentId?: string | null;
}

interface AuthzDecision {
  allow: boolean;
  reason: string;
}

const ALLOW = (reason: string): AuthzDecision => ({ allow: true, reason });
const DENY = (reason: string): AuthzDecision => ({ allow: false, reason });

/** Permissions a built-in role grants (lattice expanded). */
function rolePermissions(roleKey: string): Permission[] {
  switch (roleKey) {
    case "owner":
    case "org_admin":
      return ["administer", "edit", "view"];
    case "editor":
      return ["edit", "view"];
    case "viewer":
      return ["view"];
    case "deployer":
      return ["deploy"];
    default:
      return []; // unknown / custom roles contribute nothing in inc 1
  }
}

/** A directly-granted permission expanded down the lattice (administer⊇edit⊇view). */
function expandPermission(p: string): Permission[] {
  switch (p) {
    case "administer":
      return ["administer", "edit", "view"];
    case "edit":
      return ["edit", "view"];
    case "view":
      return ["view"];
    case "deploy":
      return ["deploy"];
    default:
      return [];
  }
}

/** Expand a principal to itself plus every group it belongs to, transitively
 * (§5 groups may nest). Returns a set of "type:id" keys for membership testing. */
async function expandPrincipal(principal: Principal, organizationId: string): Promise<Set<string>> {
  const keys = new Set<string>([`${principal.type}:${principal.id}`]);
  if (principal.type !== "identity") return keys; // group/SA nesting not needed in inc 1

  const groupIds = new Set<string>();
  // Direct groups the identity is a member of.
  const direct = await prisma.platGroupMembership.findMany({
    where: { organizationId, memberIdentityId: principal.id },
    select: { groupId: true },
  });
  for (const g of direct) groupIds.add(g.groupId);

  // Transitively, groups that contain an already-included group.
  const queue = [...groupIds];
  while (queue.length) {
    const gid = queue.shift()!;
    const parents = await prisma.platGroupMembership.findMany({
      where: { organizationId, memberGroupId: gid },
      select: { groupId: true },
    });
    for (const p of parents) {
      if (!groupIds.has(p.groupId)) {
        groupIds.add(p.groupId);
        queue.push(p.groupId);
      }
    }
  }
  for (const gid of groupIds) keys.add(`group:${gid}`);
  return keys;
}

/** The set of markings a principal (incl. its groups) holds (§7). */
async function heldMarkings(principalKeys: Set<string>, organizationId: string): Promise<Set<string>> {
  const grants = await prisma.platMarkingGrant.findMany({
    where: { organizationId },
    select: { markingId: true, principalId: true, principalType: true },
  });
  const held = new Set<string>();
  for (const g of grants) {
    if (principalKeys.has(`${g.principalType}:${g.principalId}`)) held.add(g.markingId);
  }
  return held;
}

/**
 * authorize(action, resource, ctx) → ALLOW | DENY (spec §6.1).
 * The principal and org context come from `ctx` (default: the request's
 * resolved tenant context). org_context is never trusted from input.
 */
export async function authorize(
  action: string,
  resource: AuthzResource,
  ctx: TenantContext = requireTenant(),
): Promise<AuthzDecision> {
  const organizationId = ctx.organizationId;

  // 0. Tenant boundary (defense in depth; the scoped store + RLS also enforce it).
  if (resource.organizationId !== organizationId) {
    return DENY("cross-organization: resource belongs to a different tenant");
  }

  const principalKeys = await expandPrincipal(ctx.principal, organizationId);

  // 1. MAC gate — caller must hold EVERY marking on the resource. Runs FIRST and
  //    can only subtract access. Empty marking set => trivially satisfied.
  const required = await prisma.platResourceMarking.findMany({
    where: { organizationId, resourceId: resource.id },
    select: { markingId: true },
  });
  if (required.length > 0) {
    const held = await heldMarkings(principalKeys, organizationId);
    for (const { markingId } of required) {
      if (!held.has(markingId)) {
        return DENY(`MAC: missing required marking ${markingId}`);
      }
    }
  }

  // 2. DAC (ReBAC) — gather role assignments across the resource's whole
  //    containment chain (resource → workflow → workspace → environment → org).
  //    A role at any ancestor scope flows down (`parent->permission`), so the
  //    union of granted permissions over the chain is the effective set.
  const required_perm: Permission = actionToPermission(action);

  // Platform-admin break-glass (§10): a superuser that has entered a NON-member
  // org (actingAsPlatformAdmin) is granted administer/edit/view in THAT org. It
  // runs AFTER the boundary check (step 0) and the MAC gate (step 1) — so it can
  // never cross orgs and can never bypass a marking — and it deliberately does
  // NOT grant `deploy`. The act is audited to the target org at the call site
  // (ensureAllowed). Selection-as-member is the normal role path, not this.
  if (ctx.actingAsPlatformAdmin && (["administer", "edit", "view"] as Permission[]).includes(required_perm)) {
    return ALLOW(`platform-admin break-glass: ${required_perm}`);
  }

  const scopes: Array<{ scopeType: ScopeType; scopeId: string }> = [
    { scopeType: (resource.scopeType ?? "resource"), scopeId: resource.id },
  ];
  if (resource.workflowId) scopes.push({ scopeType: "workflow", scopeId: resource.workflowId });
  if (resource.workspaceId) scopes.push({ scopeType: "workspace", scopeId: resource.workspaceId });
  if (resource.environmentId) scopes.push({ scopeType: "environment", scopeId: resource.environmentId });
  scopes.push({ scopeType: "organization", scopeId: organizationId });

  const assignments = await prisma.platRoleAssignment.findMany({
    where: {
      organizationId,
      OR: scopes.map((s) => ({ scopeType: s.scopeType, scopeId: s.scopeId })),
    },
  });

  const granted = new Set<Permission>();
  for (const a of assignments) {
    if (!principalKeys.has(`${a.principalType}:${a.principalId}`)) continue;
    for (const p of rolePermissions(a.roleKey)) granted.add(p);
  }

  // Out-of-tree sharing grants on the resource itself (§6.2).
  const shares = await prisma.platSharingGrant.findMany({
    where: { organizationId, resourceId: resource.id },
  });
  for (const s of shares) {
    if (!principalKeys.has(`${s.principalType}:${s.principalId}`)) continue;
    for (const p of expandPermission(s.permission)) granted.add(p);
  }

  if (granted.has(required_perm)) {
    return ALLOW(`granted ${required_perm} for ${action}`);
  }
  return DENY(`no ${required_perm} permission for ${action}`);
}

/** Build an AuthzResource from a stored resource row (the common case). */
export function resourceRef(row: {
  id: string;
  organizationId: string;
  workflowId?: string | null;
  workspaceId?: string | null;
  environmentId?: string | null;
}): AuthzResource {
  return {
    id: row.id,
    organizationId: row.organizationId,
    scopeType: "resource",
    workflowId: row.workflowId ?? null,
    workspaceId: row.workspaceId ?? null,
    environmentId: row.environmentId ?? null,
  };
}
