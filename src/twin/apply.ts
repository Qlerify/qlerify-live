// Set a workflow's own model — the live, in-process rebuild that runs when a
// (non-system) workflow is pointed at a Qlerify model via PUT /v1/workflow/model.
// It validates the model, stores it as a new version of the workflow's ontology
// (CAS), makes it live for the request, and drops/recreates ONLY this workflow's
// projection tables + clears its own run history. No `prisma generate`, no
// server restart — projections are raw-SQL (twin/projection-store) and commands
// dispatch dynamically from the model, so a freshly applied model is immediately
// runnable. Everything here is workflow-scoped via the ALS context; the system
// context and every OTHER workflow are untouched.

import { prisma } from "../db.js";
import { DomainError } from "../errors.js";
import { isSystemWorkflow, requireTenant } from "../platform/tenancy/context.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { createVersion, ensureOntologyResource } from "../platform/ontology-store/ontology-store.js";
import { getOntology, loadOntologyFromStrings, setWorkflowModel } from "../ontology/model.js";
import { applyModelTables } from "./projection-store.js";

/**
 * Set the ACTIVE (non-system) workflow's own model from a provided Qlerify export.
 * Stores it as a new version of the workflow's ontology (CAS) and rebuilds ONLY
 * this workflow's data plane — its own gen__p<workflow>_ tables + its own EventLog.
 * The system context and every OTHER workflow are untouched (everything here is
 * workflow-scoped via the ALS context).
 */
export async function setActiveWorkflowModel(workflow: string, overlay: string | null): Promise<{ versionId: string; seq: number; changed: boolean }> {
  const ctx = requireTenant();
  if (isSystemWorkflow() || !ctx.workflowId) {
    throw new DomainError("Setting a workflow model applies to a real (non-system) workflow — create or select one first.");
  }
  // Validate it's a loadable Qlerify model BEFORE we touch anything.
  try {
    loadOntologyFromStrings(workflow, overlay);
  } catch (e: any) {
    throw new DomainError(`Invalid Qlerify model: ${e?.message ?? String(e)}`);
  }

  // Resolve (or create) the workflow's "workflow" ontology, then store the new
  // content as its current version.
  let ont = await prisma.platOntology.findFirst({
    where: { organizationId: ctx.organizationId, workflowId: ctx.workflowId, name: "workflow" },
    select: { id: true },
  });
  if (!ont) {
    const proj = await prisma.platWorkflow.findFirst({ where: { id: ctx.workflowId, organizationId: ctx.organizationId }, select: { workspaceId: true } });
    const r = await ensureOntologyResource({ organizationId: ctx.organizationId, workflowId: ctx.workflowId, workspaceId: proj?.workspaceId ?? null, environmentId: null, name: "workflow", ownerId: ctx.principal.id });
    ont = { id: r.ontologyId };
  }
  const v = await createVersion(ctx.organizationId, ont.id, workflow, overlay, { source: "set", createdBy: ctx.principal.id });

  // Make the new model live for THIS request, then rebuild the workflow's data
  // plane for it: drop the workflow's old projection tables, create the new
  // model's, and clear the workflow's run history. All workflow-scoped.
  setWorkflowModel(ctx.workflowId, workflow, overlay, v.manifestHash);
  await applyModelTables(getOntology());
  await prisma.eventLog.deleteMany({ where: eventLogOrgWhere() });

  return { versionId: v.versionId, seq: v.seq, changed: v.changed };
}
