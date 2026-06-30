// Canonical registry of the model's domain events, used by the event bus, the
// simulator runner, and the demo UI to render the timeline.
//
// Every fact here is sourced from the live model: the event identity, role,
// bounded context and aggregate root come from the Qlerify ontology; the linear
// *order*, 5-act *phase* grouping, and *derived* flag come from the overlay
// sidecar, merged into the ontology by src/ontology/model.ts. The model is
// per-workflow (bound from the content-addressed store), so events() resolves
// the ACTIVE workflow's events; EVENTS is the system-context binding (empty).

import type { Role } from "../auth.js";
import { getOntology, ontologyCacheKey } from "../ontology/model.js";

export interface EventDef {
  name: string;
  ref: string;
  boundedContext: string;
  aggregateRoot: string;
  role: Role;
  phase: number;
  derived?: boolean;
  /** Refs of the events that must occur before this one (the `follows` DAG
   * edges). Carried through so the UI can lay the workflow out as branching
   * lanes instead of a single flattened line. */
  predecessors: string[];
}

// Build the ordered event list from the model: linearOrder() honors the
// overlay's `order` where present and falls back to topological order, so a
// model with no overlay still yields a sensible (DAG-respecting) sequence.
function buildEvents(): EventDef[] {
  const o = getOntology();
  return o.linearOrder().map((key) => {
    const e = o.eventByKey(key)!;
    return {
      name: e.name,
      ref: e.ref,
      boundedContext: e.boundedContext,
      aggregateRoot: e.aggregateRoot,
      role: e.role,
      phase: e.phase ?? 1,
      // Predecessor keys → canonical refs, so they match the `ref` of the
      // events they point at (same scheme model.ts uses to mint each ref).
      predecessors: e.predecessors.map((k) => `#/domainEvents/${k}`),
      ...(e.derived ? { derived: true as const } : {}),
    };
  });
}

// `let` + reassignment makes this an ESM live binding: importers always see the
// latest array. EVENTS is the SYSTEM-context event list, which is always empty
// (the system model carries no events); per-workflow consumers use events().
export let EVENTS: ReadonlyArray<EventDef> = [];

// If buildEvents() throws (e.g. a malformed model slipped past the loader), we
// must NOT let that crash the process at import time — it would take the whole
// server down before it can even report the problem. Instead we capture the
// message here, leave EVENTS as the last good array (empty on first failure),
// and let the frontend surface it via /sim/registry-status. registryError is a
// live binding too, so a later hot-reload that fixes the model clears it.
export let registryError: string | null = null;

function rebuildEvents(): void {
  try {
    EVENTS = buildEvents();
    registryError = null;
  } catch (err) {
    registryError = err instanceof Error ? err.message : String(err);
    // Keep the previous EVENTS so consumers that were already working keep
    // working until a corrected model is loaded.
  }
}

rebuildEvents();

// Per-WORKFLOW events. EVENTS (above) stays the SYSTEM/current-model live binding
// for system-context consumers (chat, the legacy stepper, conformance); events()
// resolves the ACTIVE workflow's events, keyed by the same content-hash cache key
// getOntology() uses. This is what makes emit()/findEvent resolve the RIGHT model
// when a non-system workflow is active.
const eventsByKey = new Map<string, ReadonlyArray<EventDef>>();

export function events(): ReadonlyArray<EventDef> {
  const key = ontologyCacheKey();
  const cached = eventsByKey.get(key);
  if (cached) return cached;
  try {
    const evs = buildEvents();
    eventsByKey.set(key, evs);
    return evs;
  } catch {
    // Do NOT cache a failure (so a corrected model retries). The system path
    // keeps its last-good EVENTS array; a non-system workflow with a bad model
    // yields [] for this call only.
    return key === "system" ? EVENTS : [];
  }
}

export function findEvent(ref: string): EventDef {
  const ev = events().find((e) => e.ref === ref);
  if (!ev) throw new Error(`unknown event ref: ${ref}`);
  return ev;
}
