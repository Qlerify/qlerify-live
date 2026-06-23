// Org-scoping for the append-only EventLog (a tenant-owned, Prisma-typed table).
// emit() stamps every new row with currentOrgId(); reads filter by it. The
// system org also sees legacy pre-tenancy rows (organizationId null) so the demo
// keeps showing its existing history.

import { SYSTEM_WORKFLOW_ID } from "../ids.js";
import { currentOrgId, currentWorkflowId } from "./context.js";

/** Prisma `where` fragment scoping EventLog reads/deletes to the active WORKFLOW
 * (a workflow belongs to one org, so workflow scoping implies org scoping). Kept
 * under the original name to avoid churn at the ~8 call sites. The system default
 * workflow also owns legacy rows written before workflow scoping existed
 * (workflowId null). */
export function eventLogOrgWhere(): Record<string, unknown> {
  const pid = currentWorkflowId();
  if (pid === SYSTEM_WORKFLOW_ID) {
    return { OR: [{ workflowId: SYSTEM_WORKFLOW_ID }, { workflowId: null }] };
  }
  // Workflow ids are globally unique so workflowId alone scopes correctly; the org
  // filter is defense-in-depth (a leaked sentinel workflowId can never cross orgs).
  return { workflowId: pid, organizationId: currentOrgId() };
}
