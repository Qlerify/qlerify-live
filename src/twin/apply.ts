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

/** A short, human label for a version's source link: the model's primary bounded
 * context name. Lets the version sidebar show "OrderManagement ↗" instead of an
 * opaque url. Best-effort — null when the json doesn't parse or names nothing. */
function boundedContextLabel(workflowJson: string): string | null {
  try {
    const spec = JSON.parse(workflowJson);
    const bc = spec?.boundedContext;
    return typeof bc === "string" && bc.trim() ? bc.trim() : null;
  } catch {
    return null;
  }
}

export interface ApplyModelOpts {
  /** Provenance recorded on the version row: set | fetch | restore | edit. */
  source?: string;
  /** The Qlerify link this content was pulled from (null for upload/paste). The
   * latest version's sourceUrl is what "reload" re-fetches. */
  sourceUrl?: string | null;
}

/**
 * Apply a Qlerify model to the workflow bound in the CURRENT context. Validates
 * the model, stores it as a new version of the workflow's ontology (CAS), makes it
 * live for the request, and drops/recreates ONLY this workflow's projection tables
 * + clears its own run history. Everything is workflow-scoped via the ALS context,
 * so callers target a specific workflow by binding it first (runWithTenant) — used
 * both by PUT /v1/workflow/model (active workflow) and by workflow creation (the
 * just-created workflow). The system context and every OTHER workflow are untouched.
 */
export async function applyWorkflowModel(
  workflow: string,
  overlay: string | null,
  opts: ApplyModelOpts = {},
): Promise<{ versionId: string; seq: number; changed: boolean }> {
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
  const sourceUrl = opts.sourceUrl ?? null;
  const v = await createVersion(ctx.organizationId, ont.id, workflow, overlay, {
    source: opts.source ?? "set",
    createdBy: ctx.principal.id,
    sourceUrl,
    sourceName: sourceUrl ? boundedContextLabel(workflow) : null,
  });

  // Make the new model live for THIS request, then rebuild the workflow's data
  // plane for it: drop the workflow's old projection tables, create the new
  // model's, and clear the workflow's run history. All workflow-scoped.
  setWorkflowModel(ctx.workflowId, workflow, overlay, v.manifestHash);
  await applyModelTables(getOntology());
  await prisma.eventLog.deleteMany({ where: eventLogOrgWhere() });

  return { versionId: v.versionId, seq: v.seq, changed: v.changed };
}
