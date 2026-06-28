// Set a workflow's own model — the live, in-process rebuild that runs when a
// (non-system) workflow is pointed at a Qlerify model via PUT /v1/workflow/model.
// It validates the model, stores it as a new version of the workflow's ontology
// (CAS), makes it live for the request, and drops/recreates ONLY this workflow's
// projection tables + clears its own run history. It then RE-INGESTS from the
// workflow's connectors and re-derives events, so the rebuilt (otherwise empty)
// tables and event log come back populated to match the new model — entities the
// model added that have no connector are left unpopulated. No `prisma generate`,
// no server restart — projections are raw-SQL (twin/projection-store) and commands
// dispatch dynamically from the model, so a freshly applied model is immediately
// runnable. Everything here is workflow-scoped via the ALS context; the system
// context and every OTHER workflow are untouched.

import { prisma } from "../db.js";
import { DomainError } from "../errors.js";
import { isSystemWorkflow, requireTenant } from "../platform/tenancy/context.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { createVersion, ensureOntologyResource } from "../platform/ontology-store/ontology-store.js";
import { getOntology, loadOntologyFromStrings, setWorkflowModel } from "../ontology/model.js";
import { reingestAll, type ReingestSummary } from "../packs/ingest.js";
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
 * live for the request, drops/recreates ONLY this workflow's projection tables +
 * clears its own run history, then re-ingests from the workflow's connectors and
 * re-derives events so the data plane is restored to match the new model (entities
 * without a connector stay empty). Everything is workflow-scoped via the ALS context,
 * so callers target a specific workflow by binding it first (runWithTenant) — used
 * both by PUT /v1/workflow/model (active workflow) and by workflow creation (the
 * just-created workflow). The system context and every OTHER workflow are untouched.
 */
export async function applyWorkflowModel(
  workflow: string,
  overlay: string | null,
  opts: ApplyModelOpts = {},
): Promise<{ versionId: string; seq: number; changed: boolean; rebuild: ReingestSummary }> {
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

  // The rebuild above left every projection table empty and wiped the event log.
  // Re-pull from this workflow's connectors and re-derive so the data and events
  // come back matching the new model — as far as the configured connectors reach.
  // Newly-added entities with no connector stay unpopulated. Best-effort: a
  // connector that can't pull doesn't fail the model update (see reingestAll).
  const rebuild = await reingestAll();

  return { versionId: v.versionId, seq: v.seq, changed: v.changed, rebuild };
}
