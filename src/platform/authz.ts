// Authorization helpers shared by the control-plane routes and the legacy model
// routes. Every decision of interest is audited (§17 MUST), and a DENY raises an
// AuthError (→ 403) — never a silent pass.

import { prisma } from "../db.js";
import { AuthError, DomainError } from "../errors.js";
import { recordAudit } from "./audit/index.js";
import { authorize, type AuthzResource } from "./pdp/index.js";
import { currentWorkflowId, isSystemWorkflow, requireTenant } from "./tenancy/context.js";
import { currentActorKind } from "./tenancy/actor.js";
import { connectorsEnabled } from "../config/features.js";
import type { TenantContext } from "./types.js";

/** Authorize `action` against `resource`; audit the decision; throw on DENY. */
export async function ensureAllowed(
  action: string,
  resource: AuthzResource,
  ctx: TenantContext = requireTenant(),
): Promise<void> {
  const decision = await authorize(action, resource, ctx);
  // A platform-admin break-glass action is recorded to the TARGET org's chain
  // (ctx.organizationId is the selected org) and clearly marked, so the tenant
  // can see exactly who entered and what they did.
  const breakGlass = !!ctx.actingAsPlatformAdmin;
  await recordAudit({
    organizationId: ctx.organizationId,
    actorPrincipalId: ctx.principal.id,
    action: breakGlass ? `break_glass.${action}` : action,
    targetRef: `resource:${resource.id}`,
    decision: decision.allow ? "allow" : "deny",
    reason: breakGlass ? `[platform-admin break-glass] ${decision.reason}` : decision.reason,
    actorKind: currentActorKind(), // "ai" when a chat write-tool triggered this → guardrail-block-rate
  });
  if (!decision.allow) throw new AuthError(decision.reason);
}

/** Gate a DATA-PLANE action on the caller's ACTIVE workflow, audit it, throw on
 * deny. The workflow + org are taken from the resolved tenant context (never from
 * client input), so a caller can only ever act on their own workflow. Org-level
 * role grants (owner/editor/viewer) flow down the containment chain to the
 * workflow scope, so an org owner/editor passes and a viewer (or a member with no
 * grant) is denied on writes. Call ONLY from on-request handlers — requireTenant()
 * fails closed off-request, which is why the underlying generic functions (sim
 * runner, tests) stay PDP-free. */
export async function guardData(action: string): Promise<void> {
  const ctx = requireTenant();
  // D7 kill-switch: a locked-down deployment disables the whole connector / AI-
  // codegen subsystem. Refuse every connector.* action before authorizing.
  if (action.startsWith("connector.") && !connectorsEnabled()) {
    throw new DomainError("the connector / AI-codegen subsystem is disabled for this deployment");
  }
  const workflowId = currentWorkflowId();
  const resource: AuthzResource = {
    id: workflowId,
    organizationId: ctx.organizationId,
    scopeType: "workflow",
    workflowId,
  };
  await ensureAllowed(action, resource, ctx);
}

/** Gate a model-lifecycle action (apply/fetch/roll/restore) on the current org's
 * primary ("workflow") ontology resource — the fix for the previously
 * unauthenticated /api/model/* routes. Falls back to org-scope authz if the org
 * has no ontology resource yet (deny-by-default unless org owner/admin). */
export async function guardModelAction(action: string): Promise<void> {
  const ctx = requireTenant();
  // These routes mutate the on-disk demo model + shared state — system workflow only.
  if (!isSystemWorkflow()) {
    throw new DomainError("Model lifecycle (fetch/apply/roll/restore) operates on the system default workflow only.");
  }
  const ont = await prisma.platOntology.findFirst({
    where: { organizationId: ctx.organizationId, workflowId: null, name: "workflow" },
    select: { resourceId: true, environmentId: true, workspaceId: true },
  });
  const resource: AuthzResource = ont
    ? {
        id: ont.resourceId,
        organizationId: ctx.organizationId,
        scopeType: "resource",
        environmentId: ont.environmentId,
        workspaceId: ont.workspaceId,
        workflowId: null,
      }
    : { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" };
  await ensureAllowed(action, resource, ctx);
}
