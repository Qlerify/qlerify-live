// Adapter ingestion (Part 2.2). Pull a bounded batch from an adapter and land it
// in the generic projection store (gen_<Entity>), stamped with the adapter's
// provenance mode and idempotent on row id. This is the ingestion substrate; the
// RawEvent/BusinessEvent split + emitting a RawPulled event are Part 5 (the one
// place this re-points later).
//
// NOTE: the target is the gen_ projection store — the only state store. Adapter
// data lands in the model's raw-SQL gen_ tables, never in any typed Prisma table
// (the schema holds only the control plane + EventLog).

import { getOntology } from "../ontology/model.js";
import { currentWorkflowId } from "../platform/tenancy/context.js";
import { newId } from "../util/ids.js";
import { setAdapterMode, type ProvMode } from "../twin/provenance.js";
import { deriveFromData } from "../twin/derive.js";
import * as store from "../twin/projection-store.js";
import { getAdapter } from "./registry.js";
import { connectorsInWorkflow } from "./connector/orchestrate.js";
import { applyFieldMap } from "./types.js";
import { appendNote } from "./connector/journal.js";

export interface IngestSummary {
  adapterId: string;
  entity: string;
  inserted: number;
  skipped: number;
  mode: ProvMode;
  /** Domain events derived from the ingested rows. Derivation auto-runs on every
   * pull (replacing the old manual "Rebuild from data" button), so the event log
   * always reflects the current data — including a backfill of rows that were
   * ingested before this became automatic. null if derivation errored, or was
   * deferred by the caller (opts.derive === false, e.g. a batch re-ingest that
   * derives once at the end). */
  derived: { events: number; instances: number } | null;
}

/** Coerce a row's values to what the raw-SQL projection columns accept. Nested
 * objects/arrays (e.g. an embedded value object a connector returned inline) are
 * JSON-stringified so they land in the TEXT column verbatim — this is the
 * "embed the VO as JSON on the row" path, free because gen_ columns are TEXT. */
function flattenValues(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  }
  return out;
}

export async function ingestPull(adapterId: string, opts: { limit?: number; derive?: boolean } = {}): Promise<IngestSummary> {
  const adapter = getAdapter(adapterId);
  if (!adapter) throw new Error(`unknown adapter: ${adapterId}`);
  // The target may be an entity OR a value object (a value object populated
  // directly gets its own gen_<VO> table). Both share the EntitySchema shape.
  const o = getOntology();
  const entity = o.entity(adapter.targetEntity) ?? o.valueObject(adapter.targetEntity);
  if (!entity) throw new Error(`adapter "${adapterId}": "${adapter.targetEntity}" is not an entity or value object in the loaded model`);

  await store.ensureTable(entity);
  const fieldMap = await adapter.mapping();
  const { rows } = await adapter.pull({ limit: opts.limit });
  const incoming = rows[adapter.targetEntity] ?? [];

  let inserted = 0;
  let skipped = 0;
  for (const raw of incoming) {
    const mapped = flattenValues(applyFieldMap(raw, fieldMap));
    const id = String(mapped.id ?? newId(adapter.targetEntity.toLowerCase()));
    mapped.id = id;
    mapped._provenance = adapter.mode; // current-state provenance on the row
    if (await store.findById(adapter.targetEntity, id)) {
      skipped++; // idempotent: a row with this id already ingested
      continue;
    }
    await store.insert(adapter.targetEntity, mapped);
    inserted++;
  }

  // The bounded context's data now comes from this adapter; the mode reflects the
  // ladder rung (simulated/recorded/live) so the UI badges follow automatically.
  await setAdapterMode(adapter.boundedContext, adapter.mode, adapter.id);
  // Journal the pull onto the connector's history so it shows in the builder's
  // notes timeline, whether triggered by the AI tool or the explorer's "Fetch
  // rows" button (every ingestPull caller is covered here — the single place).
  appendNote(adapter.id, "ingested", `Ingested ${inserted} new row(s) (${skipped} already present) into ${adapter.targetEntity}.`);

  // Ingested rows imply domain events — derive them right here so the event log
  // always tracks the data with no manual step. Run on EVERY pull (not just when
  // inserted > 0): deriveFromData is idempotent — it only fills gaps — so a pull
  // whose rows were all already present still backfills any events those rows
  // never produced (e.g. rows ingested before derivation became automatic).
  // Workflow-scoped via the active context, and best-effort: the rows are already
  // committed, so a derivation hiccup must not fail the ingest (the next pull, or
  // POST /sim/derive, retries). Covers every ingestPull caller from one place.
  // Batch callers (reingestAll) pass derive:false and derive ONCE at the end —
  // a single pass over the fully restored data is cheaper and gets cross-aggregate
  // linear order right in one go.
  let derived: { events: number; instances: number } | null = null;
  if (opts.derive !== false) {
    try {
      const r = await deriveFromData();
      derived = { events: r.totalEmitted, instances: r.instances };
      if (r.totalEmitted > 0) {
        appendNote(adapter.id, "ingested", `Derived ${r.totalEmitted} event(s) across ${r.instances} instance(s) from the data.`);
      }
    } catch {
      /* ingest succeeded; leave derivation to the next pull if it failed here */
    }
  }
  return { adapterId: adapter.id, entity: adapter.targetEntity, inserted, skipped, mode: adapter.mode, derived };
}

export interface ReingestSummary {
  /** Connectors found in the active workflow's scope. */
  connectors: number;
  /** Rows landed across all connectors this pass. */
  inserted: number;
  /** Per-connector pull results, in pull order. */
  pulls: IngestSummary[];
  /** Connectors whose pull threw (missing credentials, a target the new model
   * dropped, a code/runtime error) — reported, not fatal. */
  failures: Array<{ id: string; entity: string; error: string }>;
  /** Events derived from the combined restored data (single final pass). null
   * only if that derivation itself errored. */
  derived: { events: number; instances: number } | null;
}

/**
 * Re-pull every connector configured for the ACTIVE workflow, then derive events
 * from the combined result. This is what restores the data plane after a model
 * update drops & recreates the (now empty) projection tables and clears the run
 * history — so the tables and the event log end up matching the new model's data.
 *
 * Scope is exactly the workflow's connectors (the same set the Connectors tab
 * shows). Entities the new model ADDS that have no connector yet are simply left
 * unpopulated — there is nothing to pull for them.
 *
 * Best-effort per connector: one connector failing (missing credentials, a target
 * the new model no longer defines, a code error) does not abort the others or the
 * model update — the rest still rebuild and the failure is reported. Derivation
 * runs ONCE here over the full restored data set (callers pass derive:false to the
 * per-pull step), so events are rebuilt correctly even if the last pull errored.
 */
export async function reingestAll(opts: { limit?: number } = {}): Promise<ReingestSummary> {
  const limit = opts.limit ?? 1000;
  const connectors = connectorsInWorkflow(currentWorkflowId());
  const pulls: IngestSummary[] = [];
  const failures: ReingestSummary["failures"] = [];
  for (const cfg of connectors) {
    try {
      pulls.push(await ingestPull(cfg.id, { limit, derive: false }));
    } catch (e: any) {
      failures.push({ id: cfg.id, entity: cfg.targetEntity, error: e?.message ?? String(e) });
    }
  }
  // One derive over everything just ingested: idempotent, and the single place
  // that turns the restored rows into events for the whole workflow.
  let derived: { events: number; instances: number } | null = null;
  try {
    const r = await deriveFromData();
    derived = { events: r.totalEmitted, instances: r.instances };
  } catch {
    /* data is restored; the next pull or POST /sim/derive will derive */
  }
  return {
    connectors: connectors.length,
    inserted: pulls.reduce((n, p) => n + p.inserted, 0),
    pulls,
    failures,
    derived,
  };
}
