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
import { periodKeyOf, periodOf, cycleId } from "../twin/period.js";
import * as store from "../twin/projection-store.js";
import { getAdapter } from "./registry.js";
import { connectorsInWorkflow } from "./connector/orchestrate.js";
import { PLATFORM_TIMESTAMP_COLS } from "./connector/codegen.js";
import { applyFieldMap } from "./types.js";
import { appendNote } from "./connector/journal.js";
import { readSidecar, writeSidecar } from "./sidecar.js";
import { DomainError } from "../errors.js";

export interface IngestSummary {
  adapterId: string;
  entity: string;
  inserted: number;
  /** Rows whose id already existed with no field changes — skipped untouched. */
  skipped: number;
  /** Rows whose id already existed and whose source values drifted — the changed
   * fields were updated in place (nulls never clobber), so re-pulls track the
   * source and derivation can fire the LATER events the new state implies. */
  updated: number;
  /** Rows merged into a provisional cycle row the engine had opened lazily
   * (twin/derive.ts) — the pull enriched the placeholder instead of skipping. */
  merged: number;
  /** Cycle-hygiene findings for a period-scoped target (id recomposed, subject
   * key values missing, period defaulted) — also journaled as notes. */
  warnings?: string[];
  mode: ProvMode;
  /** Wall-clock ms of the ingest itself (table + pull + insert loop), EXCLUDING
   * derivation — the derive pass reports its own durationMs below, so the two
   * numbers deliberately don't add up to one total. */
  durationMs: number;
  /** Wall-clock ms of the adapter.pull() call alone — the fetch/network step. */
  fetchMs: number;
  /** Domain events derived from the ingested rows. Derivation auto-runs on every
   * pull (replacing the old manual "Rebuild from data" button), so the event log
   * always reflects the current data — including a backfill of rows that were
   * ingested before this became automatic. null if derivation errored, or was
   * deferred by the caller (opts.derive === false, e.g. a batch re-ingest that
   * derives once at the end). */
  derived: { events: number; instances: number; durationMs: number } | null;
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

function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

/** Platform/identity columns an upsert must never touch: identity + optimistic
 * lock + tenancy + the provisional marker (cleared only by the cycle merge). */
const UPSERT_EXCLUDED = new Set(["id", "version", "organization_id", "_provisional"]);

/** Diff an incoming mapped row against the stored one. Returns the columns to
 * update, or null when the row is unchanged (the skip case). Semantics:
 * - If the sidecar names a last-modified column (dateRoles.updated) and both
 *   sides carry the same value, the row is unchanged by definition — no field
 *   diff (the cheap watermark path).
 * - Only connector-supplied values participate; a null/absent incoming value
 *   NEVER clobbers a stored one (a source that stops returning a field must not
 *   erase what an earlier pull witnessed).
 * - createdAt may be FILLED when the stored row has none (a source can supply a
 *   missing creation date) but never overwritten — a row's origin doesn't move. */
function upsertChanges(
  mapped: Record<string, unknown>,
  existing: Record<string, unknown>,
  dateRoles?: { created?: string; updated?: string },
): Record<string, unknown> | null {
  const uCol = dateRoles?.updated;
  if (uCol && hasValue(mapped[uCol]) && hasValue(existing[uCol]) && String(mapped[uCol]) === String(existing[uCol])) {
    return null;
  }
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mapped)) {
    if (UPSERT_EXCLUDED.has(k)) continue;
    if (!hasValue(v)) continue;
    if (k === "createdAt" && hasValue(existing.createdAt)) continue;
    // Compare in the STORED shape: a boolean persists as 1/0 (projection-store
    // sqlValue), so a re-sent `true` reads back as `1` — comparing String(true)
    // to String(1) would mark every boolean-carrying row "updated" on every pull
    // forever. Coerce the incoming value the same way the write path will.
    const stored = typeof v === "boolean" ? (v ? 1 : 0) : v;
    if (hasValue(existing[k]) && String(existing[k]) === String(stored)) continue;
    changes[k] = v;
  }
  return Object.keys(changes).length ? changes : null;
}

/** Persist the pull stamp onto the adapter's sidecar (no-op for code-pack
 * adapters that have none). Fresh-read → write, the same pattern every other
 * config mutator uses, so neither side clobbers the other. */
function stampLastPull(id: string, at: string, durationMs: number): void {
  const cfg = readSidecar(id);
  if (!cfg) return;
  writeSidecar({ ...cfg, lastPullAt: at, lastPullDurationMs: durationMs });
}

const inFlight = new Set<string>();

export function isPullInFlight(adapterId: string): boolean {
  return inFlight.has(adapterId);
}

export async function ingestPull(adapterId: string, opts: { limit?: number | null; derive?: boolean } = {}): Promise<IngestSummary> {
  if (!getAdapter(adapterId)) throw new Error(`unknown adapter: ${adapterId}`); // pre-run: no adapter identity to journal against
  if (inFlight.has(adapterId)) {
    throw new DomainError(`a pull is already running for "${adapterId}" — wait for it to finish`);
  }
  inFlight.add(adapterId);
  try {
    return await runIngestPull(adapterId, opts);
  } finally {
    inFlight.delete(adapterId);
  }
}

async function runIngestPull(adapterId: string, opts: { limit?: number | null; derive?: boolean }): Promise<IngestSummary> {
  const adapter = getAdapter(adapterId)!;
  const t0 = Date.now();
  let durationMs = 0;
  let fetchMs = 0;
  let inserted = 0;
  let skipped = 0;
  let updated = 0;
  let merged = 0;
  const warnings: string[] = [];
  // dateRoles lives on the sidecar (code-pack adapters have none — undefined is
  // fine: upsertChanges just falls back to the full field diff).
  const dateRoles = readSidecar(adapterId)?.dateRoles;
  try {
    // The target may be an entity OR a value object (a value object populated
    // directly gets its own gen_<VO> table). Both share the EntitySchema shape.
    const o = getOntology();
    const entity = o.entity(adapter.targetEntity) ?? o.valueObject(adapter.targetEntity);
    if (!entity) throw new Error(`adapter "${adapterId}": "${adapter.targetEntity}" is not an entity or value object in the loaded model`);

    await store.ensureTable(entity);
    // Period-scoped cycle target (twin/period.ts): the ENGINE owns the row id —
    // canonical subject@period — so connectors never hand-compose composite keys
    // and a next-period pull creates the next cycle instead of skipping on a
    // period-less id. Divergence from a connector-supplied id is reported, not
    // silent.
    const pk = periodKeyOf(entity);
    let idRecomposed = 0;
    let missingSubject = 0;
    let periodDefaulted = 0;
    const fieldMap = await adapter.mapping();
    const tFetch = Date.now();
    const { rows } = await adapter.pull({ limit: opts.limit });
    fetchMs = Date.now() - tFetch;
    const incoming = rows[adapter.targetEntity] ?? [];

    for (const raw of incoming) {
      const mapped = flattenValues(applyFieldMap(raw, fieldMap));
      // Ingested rows carry ONLY timestamps the source actually recorded: a
      // createdAt/updatedAt the record doesn't supply lands as NULL, never as
      // insert's ingestion-time default. A fabricated "when we pulled" sits
      // indistinguishable next to real source dates — and a date role pointing
      // at the column would even certify it as a witnessed creation time
      // (derive's known=true). Unknown stays unknown; only rows created live by
      // commands stamp real wall-clock time.
      for (const c of PLATFORM_TIMESTAMP_COLS) if (!hasValue(mapped[c])) mapped[c] = null;
      let id = String(mapped.id ?? newId(adapter.targetEntity.toLowerCase()));
      if (pk) {
        // A cycle pull is a snapshot OF a period: a row without a period value
        // belongs to the period it was pulled in.
        if (!hasValue(mapped[pk.periodField])) {
          mapped[pk.periodField] = periodOf(new Date(), pk.granularity);
          periodDefaulted++;
        }
        const values = pk.subjectFields.map((f) => (hasValue(mapped[f]) ? String(mapped[f]) : null));
        if (values.some((v) => v === null)) {
          missingSubject++;
        } else {
          const canonical = cycleId(values as string[], String(mapped[pk.periodField]));
          if (hasValue(mapped.id) && String(mapped.id) !== canonical) idRecomposed++;
          id = canonical;
        }
      }
      mapped.id = id;
      mapped._provenance = adapter.mode; // current-state provenance on the row
      const existing = await store.findById(adapter.targetEntity, id);
      if (existing) {
        if (existing._provisional) {
          // A cycle row the engine opened lazily before this pull: ENRICH it
          // with the source's real values instead of skipping on the id.
          // updatedAt is left to store.update's own stamp — passing it too
          // would assign the column twice in one UPDATE.
          const changes = Object.fromEntries(Object.entries(mapped).filter(([k]) => k !== "id" && k !== "updatedAt"));
          changes._provisional = null;
          await store.update(adapter.targetEntity, id, changes, Number(existing.version ?? 0));
          merged++;
        } else {
          // Upsert: a re-pulled row whose source values drifted has its changed
          // fields updated in place, so state advancement (NEW → SHIPPED) reaches
          // the projection and derivation can fire the later events it implies.
          // touchUpdatedAt:false — the row keeps the SOURCE's last-modified value
          // (or none); stamping pull time here would fabricate a business date
          // (see the PLATFORM_TIMESTAMP_COLS comment above).
          const changes = upsertChanges(mapped, existing, dateRoles);
          if (changes) {
            await store.update(adapter.targetEntity, id, changes, Number(existing.version ?? 0), { touchUpdatedAt: false });
            updated++;
          } else {
            skipped++; // unchanged: a row with this id already ingested, no drift
          }
        }
        continue;
      }
      await store.insert(adapter.targetEntity, mapped);
      inserted++;
    }

    if (pk) {
      if (idRecomposed) warnings.push(`${idRecomposed} row(s): connector-supplied id replaced with the canonical cycle id (${pk.subjectFields.join("+")}@${pk.periodField})`);
      if (missingSubject) warnings.push(`${missingSubject} row(s) missing subject key value(s) (${pk.subjectFields.join(", ")}) — kept the connector's id; these rows cannot anchor cycle correlation`);
      if (periodDefaulted) warnings.push(`${periodDefaulted} row(s) had no ${pk.periodField} — defaulted to the current period`);
    }

    // The bounded context's data now comes from this adapter; the mode reflects the
    // ladder rung (simulated/recorded/live) so the UI badges follow automatically.
    await setAdapterMode(adapter.boundedContext, adapter.mode, adapter.id);
    durationMs = Date.now() - t0;
  } catch (e: any) {
    // Record the failed attempt — the error and how long it ran — so the pull
    // leaves a trace in the connector's history (it previously left none). Then
    // rethrow: the HTTP 400 / chat-tool error paths stay exactly as before.
    // Best-effort: journaling must never mask the original error.
    try {
      const msg = String(e?.message ?? e).slice(0, 300);
      appendNote(adapter.id, "failed", `Pull failed: ${msg}`, { durationMs: Date.now() - t0 });
    } catch { /* ignore journaling errors */ }
    throw e;
  }

  // The pull is committed — everything below is post-commit bookkeeping, kept
  // OUTSIDE the try/catch and best-effort so an fs hiccup here can neither fail
  // the ingest nor mislabel a completed run as a failed pull.
  try {
    stampLastPull(adapter.id, new Date().toISOString(), durationMs);
    // Journal the pull onto the connector's history so it shows in the builder's
    // notes timeline, whether triggered by the AI tool or the explorer's "Fetch
    // rows" button (every ingestPull caller is covered here — the single place).
    const mergedNote = merged ? `, ${merged} provisional cycle row(s) enriched` : "";
    const updatedNote = updated ? `, ${updated} updated` : "";
    appendNote(adapter.id, "ingested", `Ingested ${inserted} new row(s)${updatedNote} (${skipped} unchanged${mergedNote}) into ${adapter.targetEntity}.`, { durationMs });
    for (const w of warnings) appendNote(adapter.id, "note", `Cycle check: ${w}`);
  } catch { /* ignore bookkeeping errors */ }

  // Ingested rows imply domain events — derive them right here so the event log
  // always tracks the data with no manual step. Run on EVERY pull (not just when
  // inserted > 0): deriveFromData is idempotent — it only fills gaps — so a pull
  // whose rows were all already present still backfills any events those rows
  // never produced (e.g. rows ingested before derivation became automatic).
  // Workflow-scoped via the active context, and best-effort: the rows are already
  // committed, so a derivation hiccup must not fail the ingest (the next pull, or
  // POST /sim/derive, retries) — and must not journal a "failed" note either,
  // which is why this block sits OUTSIDE the try/catch above. Covers every
  // ingestPull caller from one place. Batch callers (reingestAll) pass
  // derive:false and derive ONCE at the end — a single pass over the fully
  // restored data is cheaper and gets cross-aggregate linear order right in one go.
  let derived: { events: number; instances: number; durationMs: number } | null = null;
  if (opts.derive !== false) {
    try {
      const r = await deriveFromData();
      derived = { events: r.totalEmitted, instances: r.instances, durationMs: r.durationMs };
      if (r.totalEmitted > 0) {
        appendNote(adapter.id, "ingested", `Derived ${r.totalEmitted} event(s) across ${r.instances} instance(s) from the data.`, { durationMs: r.durationMs });
      }
      // A trigger rule that broke fell back to the STATIC heuristic this pass —
      // whose over-broad emissions are permanent (the pairKey floor). That must
      // not be silent on the dominant (auto-derive) path: journal each error/
      // orphaned rule onto THIS connector's history where the operator sees it.
      for (const e of r.rules?.errors ?? []) {
        if (e.connector === adapter.id) appendNote(adapter.id, "rule", `Trigger rule for "${e.eventKey}" failed — the generic heuristic answered instead: ${e.error}`);
      }
      for (const d of r.rules?.disabled ?? []) {
        if (d.connector === adapter.id) appendNote(adapter.id, "rule", `Trigger rule for "${d.eventKey}" is inactive: ${d.reason}`);
      }
    } catch (e: any) {
      // The rows ARE committed, so this is not a pull failure ("failed" would
      // mislabel the run) — but it must not vanish either: a fully silent skip
      // here once hid a broken emit path for hours (rows landed, event log stayed
      // empty, nothing anywhere said why). Journal it as a note; the next pull or
      // POST /sim/derive retries.
      try {
        const msg = String(e?.message ?? e).slice(0, 300);
        appendNote(adapter.id, "note", `Rows landed, but deriving events from them failed: ${msg} — retried on the next pull or POST /sim/derive.`);
      } catch { /* ignore journaling errors */ }
    }
  }
  return {
    adapterId: adapter.id,
    entity: adapter.targetEntity,
    inserted,
    skipped,
    updated,
    merged,
    ...(warnings.length ? { warnings } : {}),
    mode: adapter.mode,
    derived,
    durationMs,
    fetchMs,
  };
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
  derived: { events: number; instances: number; durationMs: number } | null;
  /** Wall-clock ms of the whole re-ingest, INCLUDING the final derive pass. */
  durationMs: number;
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
export async function reingestAll(opts: { limit?: number | null } = {}): Promise<ReingestSummary> {
  const t0 = Date.now();
  // Default UNCAPPED: a reimport's whole point is a full restore, so every
  // connector pulls everything unless the caller windows it explicitly.
  const limit = opts.limit ?? null;
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
  let derived: { events: number; instances: number; durationMs: number } | null = null;
  try {
    const r = await deriveFromData();
    derived = { events: r.totalEmitted, instances: r.instances, durationMs: r.durationMs };
  } catch {
    /* data is restored; the next pull or POST /sim/derive will derive */
  }
  return {
    connectors: connectors.length,
    inserted: pulls.reduce((n, p) => n + p.inserted, 0),
    pulls,
    failures,
    derived,
    durationMs: Date.now() - t0,
  };
}
