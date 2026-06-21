// Org-scoping for the append-only EventLog (a tenant-owned, Prisma-typed table).
// emit() stamps every new row with currentOrgId(); reads filter by it. The
// system org also sees legacy pre-tenancy rows (organizationId null) so the demo
// keeps showing its existing history.

import { SYSTEM_PROJECT_ID } from "../ids.js";
import { currentOrgId, currentProjectId } from "./context.js";

/** Prisma `where` fragment scoping EventLog reads/deletes to the active PROJECT
 * (a project belongs to one org, so project scoping implies org scoping). Kept
 * under the original name to avoid churn at the ~8 call sites. The system default
 * project also owns legacy rows written before project scoping existed
 * (projectId null). */
export function eventLogOrgWhere(): Record<string, unknown> {
  const pid = currentProjectId();
  if (pid === SYSTEM_PROJECT_ID) {
    return { OR: [{ projectId: SYSTEM_PROJECT_ID }, { projectId: null }] };
  }
  // Project ids are globally unique so projectId alone scopes correctly; the org
  // filter is defense-in-depth (a leaked sentinel projectId can never cross orgs).
  return { projectId: pid, organizationId: currentOrgId() };
}
