// At-a-glance connection health for the Systems explorer (#bcs). A PROJECTION
// over substrate that already exists — the ontology (which entities/value objects
// each bounded context owns), the adapter registry (what's wired + its mode), and
// the gen_ projection store (row counts). No new tables, no writes, no
// healthchecks in the hot path: the four states are derived purely from data
// already on hand, so the board answers "which entity has no working connection?"
// and "which is only simulated data?" in one read.
//
// Split mirrors derive.ts / org-dashboard.ts: buildSystemsHealth() is a PURE
// function (unit-tested against an inline model); computeSystemsHealth() is the
// thin async orchestrator that gathers adapters + row counts and calls it.

import { getOntology, type Ontology } from "../ontology/model.js";
import { entitiesForBc, valueObjectsForBc } from "../ontology/bc-helpers.js";
import type { AdapterBehavior, ProvMode, SourceAdapter } from "../packs/types.js";
import { readSidecar } from "../packs/sidecar.js";
import { listOwnedAdapters } from "../packs/ownership.js";
import * as store from "./projection-store.js";

/** The four connection states a table can be in, derived from (adapter wired?,
 * adapter mode, row count). `simulated` covers both simulated and recorded data. */
type TableStatus = "live" | "simulated" | "wired_empty" | "no_adapter";

interface TableHealth {
  name: string;
  kind: "entity" | "valueObject";
  status: TableStatus;
  rows: number;
  /** The wired adapter's mode (the highest, if several target it), or null. */
  mode: ProvMode | null;
  /** The adapter whose status this row reflects, or null when none is wired. */
  adapterId: string | null;
  /** That adapter's type. Carried here because this payload spans EVERY system,
   * while the per-system adapter list does not — a table fed by an actuator has
   * to be flagged even when a different system is selected. */
  behavior: AdapterBehavior | null;
  /** Pre-formatted right-aligned detail, e.g. "live · 1,200 rows". */
  detail: string;
}

interface SystemHealth {
  name: string;
  /** Tables with data flowing through a wired adapter (live + simulated). */
  connected: number;
  total: number;
  tables: TableHealth[];
}

interface SystemsHealth {
  /** Tables that need attention (no adapter, or wired but never populated). */
  gaps: number;
  systems: SystemHealth[];
}

/** Just the adapter fields the board needs — SourceAdapter is assignable to it,
 * and tests can pass plain objects. */
/** What the health board needs of an adapter. `behavior` is NOT on SourceAdapter
 * (it lives on the sidecar), so the async orchestrator resolves it and passes it
 * in — keeping buildSystemsHealth free of I/O. */
export type AdapterRef = Pick<SourceAdapter, "id" | "boundedContext" | "targetEntity" | "mode"> & {
  behavior?: AdapterBehavior | null;
};

const MODE_RANK: Record<ProvMode, number> = { live: 3, recorded: 2, simulated: 1 };

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function classify(
  bc: string,
  name: string,
  kind: "entity" | "valueObject",
  adapters: AdapterRef[],
  rows: number,
): TableHealth {
  const wired = adapters.filter((a) => a.boundedContext === bc && a.targetEntity === name);
  if (wired.length === 0) {
    return { name, kind, status: "no_adapter", rows, mode: null, adapterId: null, behavior: null, detail: "no adapter" };
  }
  // Several adapters can target one table; the highest mode wins the dot.
  const top = wired.reduce((best, a) => (MODE_RANK[a.mode] > MODE_RANK[best.mode] ? a : best));
  const behavior = top.behavior ?? null;
  if (rows === 0) {
    return { name, kind, status: "wired_empty", rows: 0, mode: top.mode, adapterId: top.id, behavior, detail: "adapter set · no data" };
  }
  if (top.mode === "live") {
    return { name, kind, status: "live", rows, mode: "live", adapterId: top.id, behavior, detail: `live · ${fmt(rows)} rows` };
  }
  // simulated or recorded — real rows, but synthetic/replayed (the ◐ dot).
  return { name, kind, status: "simulated", rows, mode: top.mode, adapterId: top.id, behavior, detail: `${top.mode} · ${fmt(rows)} rows` };
}

/** PURE: classify every bounded context's entities + value objects into the
 * 4-state model, given the wired adapters and a name→rowCount map. */
export function buildSystemsHealth(
  ont: Ontology,
  adapters: AdapterRef[],
  rowCounts: Map<string, number>,
): SystemsHealth {
  let gaps = 0;
  const systems: SystemHealth[] = ont.boundedContexts.map((bc) => {
    const tables: TableHealth[] = [];
    for (const e of entitiesForBc(ont, bc)) tables.push(classify(bc, e.name, "entity", adapters, rowCounts.get(e.name) ?? 0));
    for (const v of valueObjectsForBc(ont, bc)) tables.push(classify(bc, v.name, "valueObject", adapters, rowCounts.get(v.name) ?? 0));
    const connected = tables.filter((t) => t.status === "live" || t.status === "simulated").length;
    gaps += tables.filter((t) => t.status === "no_adapter" || t.status === "wired_empty").length;
    return { name: bc, connected, total: tables.length, tables };
  });
  return { gaps, systems };
}

/** Async orchestrator: read the live ontology + adapter registry, count rows per
 * table (org-scoped, deduped by name since one gen_ table backs a name), then
 * build the board. Used by GET /api/bc/health. */
export async function computeSystemsHealth(): Promise<SystemsHealth> {
  const ont = getOntology();
  // One read per OWNED adapter, not per table (several tables can share one) and
  // not the whole sidecar directory (which spans every tenant). This runs on
  // every GET /api/bc/health, so the builder itself stays free of it.
  const adapters: AdapterRef[] = listOwnedAdapters().map((a) => ({
    id: a.id, boundedContext: a.boundedContext, targetEntity: a.targetEntity, mode: a.mode,
    behavior: readSidecar(a.id)?.behavior ?? null,
  }));
  const rowCounts = new Map<string, number>();
  for (const bc of ont.boundedContexts) {
    for (const t of [...entitiesForBc(ont, bc), ...valueObjectsForBc(ont, bc)]) {
      if (!rowCounts.has(t.name)) rowCounts.set(t.name, await store.countRows(t.name));
    }
  }
  return buildSystemsHealth(ont, adapters, rowCounts);
}
