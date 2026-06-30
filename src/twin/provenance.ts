// Provenance substrate (Part 2.1). Every fact the twin records carries WHERE it
// came from: synthesized locally (`simulated`), captured from a real source and
// replayed offline (`recorded`), or pulled live from the connected system
// (`live`). The adapter MODE is configured per bounded context (persisted in
// `_app_meta`); the STAMP is written PER-EVENT at the single `emit()` chokepoint,
// so "which steps are real vs simulated" stays legible even for a single-BC
// model. No real source is connected yet → everything defaults to `simulated`,
// which back-fills the entire existing demo truthfully with zero call-site edits.

import { getMeta, setMeta } from "./projection-store.js";
import { currentWorkflowId } from "../platform/tenancy/context.js";
import { SYSTEM_WORKFLOW_ID } from "../platform/ids.js";

export type ProvMode = "simulated" | "recorded" | "live";
export const PROV_MODES: ProvMode[] = ["simulated", "recorded", "live"];

interface AdapterMode {
  mode: ProvMode;
  adapter?: string; // id of the adapter that owns this BC's data, if any
  at?: string; // ISO timestamp the mode was last set
}

// The `_app_meta` table is a single GLOBAL key-value store (not per-workflow), so
// the provenance modes MUST be keyed by the active workflow — otherwise one
// tenant's `live` connector flips the default provenance for every tenant that
// shares a bounded-context NAME (the F-28 cross-tenant bleed). Workflow ids are
// globally unique, so the workflow id alone scopes correctly. Off-request
// (boot/sim/tests) resolves to the system workflow sentinel.
function metaKey(): string {
  let wf: string;
  try {
    wf = currentWorkflowId();
  } catch {
    wf = SYSTEM_WORKFLOW_ID; // bound org with no workflow → system sentinel (never a real wf)
  }
  return `adapterModes::${wf}`;
}

// In-process cache so `emit()` doesn't hit the DB on every event. Keyed per
// workflow (a single shared object would re-introduce the cross-tenant bleed the
// meta key closes). Populated lazily; the workflow's entry is invalidated on every
// write. (BCs can change on a model swap, but stale entries for absent BCs are
// simply never read — a new model's BCs default to `simulated`.)
const cache = new Map<string, Record<string, AdapterMode>>();

function safeParse(raw: string): Record<string, AdapterMode> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, AdapterMode>) : {};
  } catch {
    return {};
  }
}

/** The configured adapter mode per bounded context for the active workflow (cached). */
async function getAdapterModes(): Promise<Record<string, AdapterMode>> {
  const key = metaKey();
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = await getMeta(key);
  const modes = raw ? safeParse(raw) : {};
  cache.set(key, modes);
  return modes;
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
  const key = metaKey();
  const modes = { ...(await getAdapterModes()) };
  modes[boundedContext] = { mode, adapter, at: new Date().toISOString() };
  cache.set(key, modes);
  await setMeta(key, JSON.stringify(modes));
}

// ---------------------------------------------------------------------------
// /sim/meta provenance block — drives the dashboard legend + "X of N steps real"
// rollup + per-step badges. Pure: callers pass the model shape + event counts.
// ---------------------------------------------------------------------------

interface ProvenanceMeta {
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
