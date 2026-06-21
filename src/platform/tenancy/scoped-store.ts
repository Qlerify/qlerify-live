// The TenantDataSource seam: the single, mandatory injection point that turns the
// ALS tenant context into a concrete organization_id on every tenant-owned data
// access. Today (SQLite) it injects `organization_id = <ctx>` into the WHERE /
// CREATE of each statement and refuses to proceed without a context. Tomorrow
// (Postgres, increment 2's first task) the SAME seam sets the RLS GUC
// (`SET LOCAL app.current_org`) per transaction and the predicate moves into the
// database — callers do not change.
//
// CRITICAL property: callers NEVER pass an organization_id. It is read here from
// requireTenant(), so a client-supplied org id physically cannot reach a query.
// This is the load-bearing substitute for RLS on SQLite (spec §9), DISCLOSED as
// app-enforced (not DB-enforced) until Postgres.

import { requireTenant } from "./context.js";

export class CrossTenantError extends Error {
  readonly code = "CROSS_TENANT";
  readonly status = 403;
  constructor(message = "cross-organization access denied") {
    super(message);
  }
}

/** The current request's organization id (throws if there is no context). */
export function orgId(): string {
  return requireTenant().organizationId;
}

/** Spread into any Prisma `where` on a tenant-owned table to scope it to the
 * current org. The org value comes ONLY from the resolved context. */
export function orgScope(): { organizationId: string } {
  return { organizationId: requireTenant().organizationId };
}

/** Stamp the current org onto a row being created on a tenant-owned table. */
export function orgStamp<T extends Record<string, unknown>>(data: T): T & { organizationId: string } {
  return { ...data, organizationId: requireTenant().organizationId };
}

/** Defense-in-depth boundary check (spec §6.1 step 0): a row fetched by any path
 * must belong to the current org. Throws CrossTenantError otherwise. A null row
 * (not found, or scoped out) is returned as-is for the caller to 404. */
export function assertSameOrg<T extends { organizationId: string } | null>(row: T): T {
  if (row && row.organizationId !== requireTenant().organizationId) {
    throw new CrossTenantError();
  }
  return row;
}
