// Canonical registry of all 28 domain events, used by the event bus, the
// simulator runner, and the demo UI to render the timeline.
//
// The event facts — name, role, bounded context, aggregate root — are sourced
// from the Qlerify ontology (.qlerify/workflow.json), so they can never drift
// from the model. See src/ontology/model.ts. A conformance test locks this
// linkage in place: tests/ontology/conformance.test.ts.
//
// This file carries only what the model does NOT encode:
//   - the simulator's canonical 28-step *linearization* of the DAG (the demo
//     replays events in this order), captured as the order of STEP_SEQUENCE;
//   - `phase`, the 5-act grouping the demo UI uses;
//   - `derived`, marking the two events the rules engine emits automatically
//     rather than a user action.

import type { Role } from "../auth.js";
import { getOntology, onOntologyReload } from "../ontology/model.js";

export interface EventDef {
  name: string;
  ref: string;
  boundedContext: "Helix" | "PRIM" | "SAP" | "ESTER" | "Compass" | "Test" | "Logistics";
  aggregateRoot: string;
  role: Role;
  phase: 1 | 2 | 3 | 4 | 5;
  derived?: boolean;
}

interface StepOverlay {
  ref: string;
  phase: 1 | 2 | 3 | 4 | 5;
  derived?: boolean;
}

// The demo's linear walk through the `follows` DAG, plus the two code-only
// annotations (phase, derived). Order is significant: the simulator steps
// 1..28 in this exact sequence, and src/events/clock.ts indexes durations by it.
const STEP_SEQUENCE: ReadonlyArray<StepOverlay> = [
  // Phase 1 — Demand & Product Structure
  { ref: "#/domainEvents/HardwareDemandCreated", phase: 1 },
  { ref: "#/domainEvents/ProjectCreated", phase: 1 },
  { ref: "#/domainEvents/BOMDefined", phase: 1 },
  { ref: "#/domainEvents/BOMFrozenAtDS1", phase: 1 },
  { ref: "#/domainEvents/BuildQuantityDefined", phase: 1 },

  // Phase 2 — Supply & Material Readiness
  { ref: "#/domainEvents/MaterialDemandSpecified", phase: 2 },
  { ref: "#/domainEvents/MaterialOrdered", phase: 2 },
  { ref: "#/domainEvents/SupplierConfirmedOrderWithETA", phase: 2 },
  { ref: "#/domainEvents/MaterialETAChanged", phase: 2 },
  { ref: "#/domainEvents/MaterialShortageIdentified", phase: 2, derived: true },

  // Phase 3 — Build Planning & Engineering Gates
  { ref: "#/domainEvents/EngineeringChangeRaised", phase: 3 },
  { ref: "#/domainEvents/EngineeringChangeApproved", phase: 3 },
  { ref: "#/domainEvents/BOMFrozenAtDS2", phase: 3 },
  { ref: "#/domainEvents/EngineeringReleaseApproved", phase: 3 },
  { ref: "#/domainEvents/BuildPrioritySet", phase: 3 },
  { ref: "#/domainEvents/BuildPlanUpdated", phase: 3 },

  // Phase 4 — Lock & Production Execution
  { ref: "#/domainEvents/BuildPlanLocked", phase: 4 },
  { ref: "#/domainEvents/BuildReleasedToSite", phase: 4 },
  { ref: "#/domainEvents/ProductionLineBooked", phase: 4 },
  { ref: "#/domainEvents/MaterialReceivedAtSite", phase: 4 },
  { ref: "#/domainEvents/MaterialKitCompleted", phase: 4, derived: true },
  { ref: "#/domainEvents/ProductionStarted", phase: 4 },

  // Phase 5 — Test, Release & Delivery
  { ref: "#/domainEvents/BoardTestPassed", phase: 5 },
  { ref: "#/domainEvents/FirstArticleInspectionPassed", phase: 5 },
  { ref: "#/domainEvents/BuildReachedRTD", phase: 5 },
  { ref: "#/domainEvents/UnitsPickedAndPacked", phase: 5 },
  { ref: "#/domainEvents/ShipmentDispatched", phase: 5 },
  { ref: "#/domainEvents/UnitReceivedByCustomer", phase: 5 },
];

function buildEvents(): EventDef[] {
  return STEP_SEQUENCE.map((step) => {
    const event = getOntology().requireEventByRef(step.ref);
    return {
      name: event.name,
      ref: event.ref,
      boundedContext: event.boundedContext as EventDef["boundedContext"],
      aggregateRoot: event.aggregateRoot,
      role: event.role as Role,
      phase: step.phase,
      ...(step.derived ? { derived: true as const } : {}),
    };
  });
}

// `let` + reassignment makes this an ESM live binding: importers always see the
// latest array, so a hot-reload of the model (onOntologyReload) is reflected
// everywhere EVENTS is used without any consumer changes.
export let EVENTS: ReadonlyArray<EventDef> = [];

// If the loaded model doesn't line up with the simulator's STEP_SEQUENCE (e.g. a
// different workflow.json got synced in), buildEvents() throws. We must NOT let
// that crash the process at import time — it would take the whole server down
// before it can even report the problem. Instead we capture the message here,
// leave EVENTS as the last good array (empty on first failure), and let the
// frontend surface it via /sim/registry-status. registryError is a live binding
// too, so a later hot-reload that fixes the model clears it automatically.
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
