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
import { newId } from "../util/ids.js";
import { setAdapterMode, type ProvMode } from "../twin/provenance.js";
import * as store from "../twin/projection-store.js";
import { getAdapter } from "./registry.js";
import { applyFieldMap } from "./types.js";
import { appendNote } from "./connector/journal.js";

export interface IngestSummary {
  adapterId: string;
  entity: string;
  inserted: number;
  skipped: number;
  mode: ProvMode;
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

export async function ingestPull(adapterId: string, opts: { limit?: number } = {}): Promise<IngestSummary> {
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
  return { adapterId: adapter.id, entity: adapter.targetEntity, inserted, skipped, mode: adapter.mode };
}
