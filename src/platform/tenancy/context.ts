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
//   - currentOrgId()   → falls back to the SYSTEM org when there is no context.
//                        Used by data-plane chokepoints (the event bus, the gen_
//                        projection store, EventLog reads) so every non-request
//                        context (boot, fs.watch, the sim runner, tests,
//                        module-load) keeps working as the system tenant.
//                        This is the ONLY sanctioned fail-open, and it is scoped
//                        to non-request execution.

import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantContext } from "../types.js";
import { SYSTEM_ORG_ID, SYSTEM_PROJECT_ID } from "../ids.js";
import { NoActiveProjectError } from "../../errors.js";

export class TenantContextMissingError extends Error {
  readonly code = "TENANT_CONTEXT_MISSING";
  readonly status = 401;
  constructor(message = "no tenant context: organization_id could not be derived from the request") {
    super(message);
  }
}

const als = new AsyncLocalStorage<TenantContext>();

/** Run `fn` with the tenant context bound (proper scoped run; restores after). */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Bind the context for the remainder of the current async execution. Used by
 * the Fastify onRequest hook, where there is no single function to wrap. */
export function enterTenant(ctx: TenantContext): void {
  als.enterWith(ctx);
}

/** The current context, or undefined when none is bound. */
export function tenantContext(): TenantContext | undefined {
  return als.getStore();
}

/** The current context or a hard failure — for tenant-owned operations. */
export function requireTenant(): TenantContext {
  const ctx = als.getStore();
  if (!ctx) throw new TenantContextMissingError();
  return ctx;
}

/** Data-plane organization id: the bound org, else the system org. */
export function currentOrgId(): string {
  return als.getStore()?.organizationId ?? SYSTEM_ORG_ID;
}

/** True when running as (or defaulting to) the system tenant. */
export function isSystemContext(): boolean {
  return (als.getStore()?.organizationId ?? SYSTEM_ORG_ID) === SYSTEM_ORG_ID;
}

/** The active project id: the bound project, else the virtual SYSTEM project.
 *
 * The `?? SYSTEM_PROJECT_ID` fallback is scoped to two SAFE cases only:
 *   - no store at all → a non-request context (boot, fs.watch, sim, tests) acts
 *     as the system tenant (resolving to the empty system-context model);
 *   - a bound SYSTEM org with no project → the same virtual system context.
 * SYSTEM_PROJECT_ID is a sentinel: no real project row carries it (the system
 * org is seeded with zero projects). A bound NON-system org with no project is
 * the empty-org state (fresh org, or its last project was deleted): it must NOT
 * fall open into the system data plane, so it throws — every project-scoped
 * read/write fails closed with a clean 409. */
export function currentProjectId(): string {
  const store = als.getStore();
  if (!store) return SYSTEM_PROJECT_ID;
  if (store.projectId) return store.projectId;
  if (store.organizationId === SYSTEM_ORG_ID) return SYSTEM_PROJECT_ID;
  throw new NoActiveProjectError();
}

/** True when running in the virtual SYSTEM context — the system-context model
 * (empty unless a workflow.json is on disk) + un-prefixed gen_ tables. This is
 * the no-store path (boot/module-load/sim/tests) and a bound SYSTEM org with no
 * project. A bound non-system org with no project is NOT the system context
 * (returns false), so the data plane never mistakes an empty tenant org for it. */
export function isSystemProject(): boolean {
  const store = als.getStore();
  if (!store) return true; // non-request context → system tenant
  if (store.projectId) return store.projectId === SYSTEM_PROJECT_ID;
  return store.organizationId === SYSTEM_ORG_ID;
}
