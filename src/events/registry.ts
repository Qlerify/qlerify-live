// Canonical registry of all 28 domain events from the Qlerify workflow.
// Each entry encodes: name (human-readable), ref ($ref path), bounded context,
// aggregate root, and the role/lane that emits it. Used by the event bus,
// the simulator runner, and the demo UI to render the timeline.

import type { Role } from "../auth.js";

export interface EventDef {
  name: string;
  ref: string;
  boundedContext: "Helix" | "PRIM" | "SAP" | "ESTER" | "Compass" | "Test" | "Logistics";
  aggregateRoot: string;
  role: Role;
  phase: 1 | 2 | 3 | 4 | 5;
  derived?: boolean;
}

export const EVENTS: ReadonlyArray<EventDef> = [
  // Phase 1 — Demand & Product Structure
  { name: "Hardware Demand Created",      ref: "#/domainEvents/HardwareDemandCreated",      boundedContext: "Helix",  aggregateRoot: "Demand",             role: "Product Manager",       phase: 1 },
  { name: "Project Created",              ref: "#/domainEvents/ProjectCreated",             boundedContext: "PRIM",   aggregateRoot: "Project",            role: "Product Manager",       phase: 1 },
  { name: "BOM Defined",                  ref: "#/domainEvents/BOMDefined",                 boundedContext: "PRIM",   aggregateRoot: "Project",            role: "Designer",              phase: 1 },
  { name: "BOM Frozen At DS1",            ref: "#/domainEvents/BOMFrozenAtDS1",             boundedContext: "PRIM",   aggregateRoot: "Project",            role: "Configuration Manager", phase: 1 },
  { name: "Build Quantity Defined",       ref: "#/domainEvents/BuildQuantityDefined",       boundedContext: "Helix",  aggregateRoot: "BuildPlan",          role: "Planner",               phase: 1 },

  // Phase 2 — Supply & Material Readiness
  { name: "Material Demand Specified",    ref: "#/domainEvents/MaterialDemandSpecified",    boundedContext: "Helix",  aggregateRoot: "Build",              role: "Supply Planner",        phase: 2 },
  { name: "Material Ordered",             ref: "#/domainEvents/MaterialOrdered",            boundedContext: "SAP",    aggregateRoot: "PurchaseOrder",      role: "Buyer",                 phase: 2 },
  { name: "Supplier Confirmed Order With ETA", ref: "#/domainEvents/SupplierConfirmedOrderWithETA", boundedContext: "SAP", aggregateRoot: "PurchaseOrder", role: "Supplier",            phase: 2 },
  { name: "Material ETA Changed",         ref: "#/domainEvents/MaterialETAChanged",         boundedContext: "SAP",    aggregateRoot: "PurchaseOrder",      role: "Supplier",              phase: 2 },
  { name: "Material Shortage Identified", ref: "#/domainEvents/MaterialShortageIdentified", boundedContext: "Helix",  aggregateRoot: "Build",              role: "Automation",            phase: 2, derived: true },

  // Phase 3 — Build Planning & Engineering Gates
  { name: "Engineering Change Raised",    ref: "#/domainEvents/EngineeringChangeRaised",    boundedContext: "ESTER",  aggregateRoot: "EngineeringChange",  role: "Designer",              phase: 3 },
  { name: "Engineering Change Approved",  ref: "#/domainEvents/EngineeringChangeApproved",  boundedContext: "ESTER",  aggregateRoot: "EngineeringChange",  role: "Configuration Manager", phase: 3 },
  { name: "BOM Frozen At DS2",            ref: "#/domainEvents/BOMFrozenAtDS2",             boundedContext: "PRIM",   aggregateRoot: "Project",            role: "Configuration Manager", phase: 3 },
  { name: "Engineering Release Approved", ref: "#/domainEvents/EngineeringReleaseApproved", boundedContext: "PRIM",   aggregateRoot: "EngineeringRelease", role: "Configuration Manager", phase: 3 },
  { name: "Build Priority Set",           ref: "#/domainEvents/BuildPrioritySet",           boundedContext: "Helix",  aggregateRoot: "Build",              role: "Planner",               phase: 3 },
  { name: "Build Plan Updated",           ref: "#/domainEvents/BuildPlanUpdated",           boundedContext: "Helix",  aggregateRoot: "BuildPlan",          role: "Planner",               phase: 3 },

  // Phase 4 — Lock & Production Execution
  { name: "Build Plan Locked",            ref: "#/domainEvents/BuildPlanLocked",            boundedContext: "Helix",  aggregateRoot: "BuildPlan",          role: "Configuration Manager", phase: 4 },
  { name: "Build Released To Site",       ref: "#/domainEvents/BuildReleasedToSite",        boundedContext: "Helix",  aggregateRoot: "Build",              role: "Planner",               phase: 4 },
  { name: "Production Line Booked",       ref: "#/domainEvents/ProductionLineBooked",       boundedContext: "Compass", aggregateRoot: "LineBooking",       role: "Production Planner",    phase: 4 },
  { name: "Material Received At Site",    ref: "#/domainEvents/MaterialReceivedAtSite",     boundedContext: "SAP",    aggregateRoot: "PurchaseOrder",      role: "Goods Receiving",       phase: 4 },
  { name: "Material Kit Completed",       ref: "#/domainEvents/MaterialKitCompleted",       boundedContext: "Helix",  aggregateRoot: "Build",              role: "Automation",            phase: 4, derived: true },
  { name: "Production Started",           ref: "#/domainEvents/ProductionStarted",          boundedContext: "Helix",  aggregateRoot: "Build",              role: "Production",            phase: 4 },

  // Phase 5 — Test, Release & Delivery
  { name: "Board Test Passed",            ref: "#/domainEvents/BoardTestPassed",            boundedContext: "Test",   aggregateRoot: "TestResult",         role: "Test Engineer",         phase: 5 },
  { name: "First Article Inspection Passed", ref: "#/domainEvents/FirstArticleInspectionPassed", boundedContext: "Test", aggregateRoot: "TestResult",      role: "Quality Engineer",      phase: 5 },
  { name: "Build Reached RTD",            ref: "#/domainEvents/BuildReachedRTD",            boundedContext: "Helix",  aggregateRoot: "Build",              role: "Quality Engineer",      phase: 5 },
  { name: "Units Picked And Packed",      ref: "#/domainEvents/UnitsPickedAndPacked",       boundedContext: "Logistics", aggregateRoot: "Shipment",        role: "Warehouse",             phase: 5 },
  { name: "Shipment Dispatched",          ref: "#/domainEvents/ShipmentDispatched",         boundedContext: "Logistics", aggregateRoot: "Shipment",        role: "Logistics",             phase: 5 },
  { name: "Unit Received By Customer",    ref: "#/domainEvents/UnitReceivedByCustomer",     boundedContext: "Logistics", aggregateRoot: "Shipment",        role: "Customer",              phase: 5 },
];

export function findEvent(ref: string): EventDef {
  const ev = EVENTS.find((e) => e.ref === ref);
  if (!ev) throw new Error(`unknown event ref: ${ref}`);
  return ev;
}
