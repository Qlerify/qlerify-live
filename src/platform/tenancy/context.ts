// Per-request tenant context, carried in an AsyncLocalStorage so no service
// downstream has to thread organization_id through call signatures — and, more
// importantly, so organization_id can ONLY come from the resolved identity, never
// from a client header/body/path (spec §11 invariant #1).
//
// Two accessors with deliberately different failure modes:
//   - requireTenant()  → THROWS when there is no context. Used by tenant-owned
//                        control-plane operations: this reproduces RLS's
//                        deny-by-default as a hard failure (a missing tenant is
//                        never a silent empty result).
//   - currentOrgId()   → for a NON-request context (boot, fs.watch, the sim
//                        runner, tests, module-load) falls back to the platform
//                        sentinel id (a constant — NO DB row). This is the ONLY
//                        sanctioned fail-open and it is scoped to off-request
//                        execution; a BOUND request that has no org fails CLOSED.
//   - requireIdentity()→ THROWS when there is no context, but tolerates a context
//                        with no org. The two pre-org endpoints (whoami,
//                        create-organization) use it: they need the authenticated
//                        identity, not a tenant.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext, TenantContext } from "../types.js";
import { SYSTEM_ORG_ID, SYSTEM_WORKFLOW_ID } from "../ids.js";
import { NoActiveWorkflowError } from "../../errors.js";

export class TenantContextMissingError extends Error {
  readonly code = "TENANT_CONTEXT_MISSING";
  readonly status = 401;
  constructor(message = "no tenant context: organization_id could not be derived from the request") {
    super(message);
  }
}

const als = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the context bound (proper scoped run; restores after). */
export function runWithTenant<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Bind the context for the remainder of the current async execution. Used by
 * the Fastify onRequest hook, where there is no single function to wrap. */
export function enterTenant(ctx: RequestContext): void {
  als.enterWith(ctx);
}

/** The current context, or undefined when none is bound. */
export function tenantContext(): RequestContext | undefined {
  return als.getStore();
}

/** The current ORG-bound context or a hard failure — for tenant-owned operations.
 * Fails closed both when there is no context AND when the context is identity-only
 * (no org): an org-scoped handler can never run without a bound organization. */
export function requireTenant(): TenantContext {
  const ctx = als.getStore();
  if (!ctx) throw new TenantContextMissingError();
  if (!ctx.organizationId) throw new TenantContextMissingError("no organization in context");
  return ctx as TenantContext;
}

/** The current AUTHENTICATED context (org optional) or a hard failure — for the
 * pre-org endpoints (whoami, create-organization) that need the identity, not a
 * tenant. */
export function requireIdentity(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) throw new TenantContextMissingError("no authenticated identity in context");
  return ctx;
}

/** Data-plane organization id. Off-request (no context) → the platform sentinel
 * (a constant, no DB row). A bound request with no org FAILS CLOSED — an
 * identity-only request must never reach the org-scoped data plane. */
export function currentOrgId(): string {
  const store = als.getStore();
  if (!store) return SYSTEM_ORG_ID;
  if (store.organizationId) return store.organizationId;
  throw new TenantContextMissingError("no organization in context");
}

/** The active workflow id: the bound workflow, else the virtual SYSTEM workflow.
 *
 * The `?? SYSTEM_WORKFLOW_ID` fallback fires ONLY off-request (no store) — boot,
 * fs.watch, sim, tests, module-load — resolving to the empty system-context
 * model. SYSTEM_WORKFLOW_ID is a sentinel: no real workflow row carries it. A
 * BOUND org with no workflow is the empty-org state (fresh org, or its last
 * workflow was deleted): it must NOT fall open into the system data plane, so it
 * throws — every workflow-scoped read/write fails closed with a clean 409. */
export function currentWorkflowId(): string {
  const store = als.getStore();
  if (!store) return SYSTEM_WORKFLOW_ID;
  if (store.workflowId) return store.workflowId;
  throw new NoActiveWorkflowError();
}

/** True when running in the virtual SYSTEM context — the (always) empty
 * system-context model + un-prefixed gen_ tables. This
 * is ONLY the no-store path (boot/module-load/sim/tests). A bound org — with or
 * without a workflow — is never the system context, so the data plane never
 * mistakes an empty tenant org for it. */
export function isSystemWorkflow(): boolean {
  const store = als.getStore();
  if (!store) return true; // off-request → empty system context
  return store.workflowId === SYSTEM_WORKFLOW_ID;
}
