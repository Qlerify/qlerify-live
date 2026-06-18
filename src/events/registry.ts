// Canonical registry of the model's domain events, used by the event bus, the
// simulator runner, and the demo UI to render the timeline.
//
// Every fact here is sourced from the live model: the event identity, role,
// bounded context and aggregate root come from the Qlerify ontology
// (.qlerify/workflow.json); the linear *order*, 5-act *phase* grouping, and
// *derived* flag come from the overlay sidecar (.qlerify/overlay.json), merged
// into the ontology by src/ontology/model.ts. Nothing is hardcoded to a specific
// domain anymore — swap the model + overlay and EVENTS reconfigures itself.
// A conformance test locks the linkage: tests/ontology/conformance.test.ts.

import type { Role } from "../auth.js";
import { getOntology, onOntologyReload } from "../ontology/model.js";

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
// latest array, so a hot-reload of the model (onOntologyReload) is reflected
// everywhere EVENTS is used without any consumer changes.
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
onOntologyReload(rebuildEvents);

export function findEvent(ref: string): EventDef {
  const ev = EVENTS.find((e) => e.ref === ref);
  if (!ev) throw new Error(`unknown event ref: ${ref}`);
  return ev;
}
