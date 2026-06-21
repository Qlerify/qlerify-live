// Provenance substrate (Part 2.1). Every fact the twin records carries WHERE it
// came from: synthesized locally (`simulated`), captured from a real source and
// replayed offline (`recorded`), or pulled live from the connected system
// (`live`). The adapter MODE is configured per bounded context (persisted in
// `_app_meta`); the STAMP is written PER-EVENT at the single `emit()` chokepoint,
// so "which steps are real vs simulated" stays legible even for a single-BC
// model. No real source is connected yet → everything defaults to `simulated`,
// which back-fills the entire existing demo truthfully with zero call-site edits.

import { getMeta, setMeta } from "./projection-store.js";

export type ProvMode = "simulated" | "recorded" | "live";
export const PROV_MODES: ProvMode[] = ["simulated", "recorded", "live"];

export interface AdapterMode {
  mode: ProvMode;
  adapter?: string; // id of the adapter that owns this BC's data, if any
  at?: string; // ISO timestamp the mode was last set
}

const META_KEY = "adapterModes";

// In-process cache so `emit()` doesn't hit the DB on every event. Populated
// lazily; invalidated on every write. (BCs can change on a model swap, but stale
// entries for absent BCs are simply never read — a new model's BCs default to
// `simulated`.)
let cache: Record<string, AdapterMode> | null = null;

/** Drop the in-process cache (tests + after an out-of-band meta change). */
export function invalidateModesCache(): void {
  cache = null;
}

function safeParse(raw: string): Record<string, AdapterMode> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, AdapterMode>) : {};
  } catch {
    return {};
  }
}

/** The configured adapter mode per bounded context (cached). */
export async function getAdapterModes(): Promise<Record<string, AdapterMode>> {
  if (cache) return cache;
  const raw = await getMeta(META_KEY);
  cache = raw ? safeParse(raw) : {};
  return cache;
}

/** Default provenance mode for events a bounded context emits (`simulated` if no
 * adapter has claimed it). Read at the `emit()` chokepoint. */
export async function provenanceFor(boundedContext: string): Promise<ProvMode> {
  const modes = await getAdapterModes();
  return modes[boundedContext]?.mode ?? "simulated";
}

/** Set the mode for a bounded context (persisted + cached). An adapter flips
 * this as it climbs the mode ladder: simulated → recorded → live. */
export async function setAdapterMode(boundedContext: string, mode: ProvMode, adapter?: string): Promise<void> {
  const modes = { ...(await getAdapterModes()) };
  modes[boundedContext] = { mode, adapter, at: new Date().toISOString() };
  cache = modes;
  await setMeta(META_KEY, JSON.stringify(modes));
}

// ---------------------------------------------------------------------------
// /sim/meta provenance block — drives the dashboard legend + "X of N steps real"
// rollup + per-step badges. Pure: callers pass the model shape + event counts.
// ---------------------------------------------------------------------------

export interface ProvenanceMeta {
  byContext: Record<string, { mode: ProvMode; adapter?: string; at?: string; eventCount: number }>;
  /** Step counts by mode across the model's events (a "step" = one model event,
   * its mode = its bounded context's mode). `real` = recorded + live. */
  steps: { total: number; simulated: number; recorded: number; live: number; real: number };
}

export async function provenanceMeta(
  boundedContexts: string[],
  events: Array<{ boundedContext: string }>,
  eventCountByContext: Record<string, number>,
): Promise<ProvenanceMeta> {
  const modes = await getAdapterModes();
  const byContext: ProvenanceMeta["byContext"] = {};
  for (const bc of boundedContexts) {
    const m = modes[bc];
    byContext[bc] = { mode: m?.mode ?? "simulated", adapter: m?.adapter, at: m?.at, eventCount: eventCountByContext[bc] ?? 0 };
  }
  const steps = { total: events.length, simulated: 0, recorded: 0, live: 0, real: 0 };
  for (const e of events) {
    const mode = modes[e.boundedContext]?.mode ?? "simulated";
    steps[mode]++;
  }
  steps.real = steps.recorded + steps.live;
  return { byContext, steps };
}
