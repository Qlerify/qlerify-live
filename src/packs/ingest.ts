// Adapter ingestion (Part 2.2). Pull a bounded batch from an adapter and land it
// in the generic projection store (gen_<Entity>), stamped with the adapter's
// provenance mode and idempotent on row id. This is the ingestion substrate; the
// RawEvent/BusinessEvent split + emitting a RawPulled event are Part 5 (the one
// place this re-points later).
//
// NOTE: the target is the gen_ projection store. The Ericsson demo's typed Prisma
// read-models (Demand/PurchaseOrder/…) are NOT written here — wiring adapter data
// into those is part of retiring the Ericsson dual-track, deliberately out of
// scope for adapter v1 (which stays strictly additive).

import { getOntology } from "../ontology/model.js";
import { newId } from "../util/ids.js";
import { setAdapterMode, type ProvMode } from "../twin/provenance.js";
import * as store from "../twin/projection-store.js";
import { getAdapter } from "./registry.js";
import { applyFieldMap } from "./types.js";

export interface IngestSummary {
  adapterId: string;
  entity: string;
  inserted: number;
  skipped: number;
  mode: ProvMode;
}

export async function ingestPull(adapterId: string, opts: { limit?: number } = {}): Promise<IngestSummary> {
  const adapter = getAdapter(adapterId);
  if (!adapter) throw new Error(`unknown adapter: ${adapterId}`);
  const entity = getOntology().entity(adapter.targetEntity);
  if (!entity) throw new Error(`adapter "${adapterId}": entity "${adapter.targetEntity}" is not in the loaded model`);

  await store.ensureTable(entity);
  const fieldMap = await adapter.mapping();
  const { rows } = await adapter.pull({ limit: opts.limit });
  const incoming = rows[adapter.targetEntity] ?? [];

  let inserted = 0;
  let skipped = 0;
  for (const raw of incoming) {
    const mapped = applyFieldMap(raw, fieldMap);
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
  return { adapterId: adapter.id, entity: adapter.targetEntity, inserted, skipped, mode: adapter.mode };
}
