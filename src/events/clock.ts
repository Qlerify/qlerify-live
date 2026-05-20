// Simulated business clock.
//
// The simulator fires 28 events in seconds of wall-clock time, but in the
// real world the same flow takes ~2 months. To let the demo *show* the
// real timing — "the supplier slipped this PO by 14 days" — we tag every
// EventLog row with a simulated `businessAt` date derived from cumulative
// per-step durations.
//
// occurredAt = real wall-clock (when the simulator recorded it)
// businessAt = simulated business time (what the audience reads)

const SIM_BASE_MS = new Date("2026-04-01T08:00:00Z").getTime();

// Hours from the previous step. Index 0 is the demand-creation event (t=0).
// These follow the spec's narrative chronology — supplier ETA slip alone
// accounts for two weeks, transit four days, etc.
export const STEP_DURATIONS_HOURS: ReadonlyArray<number> = [
  0,    //  0  Hardware Demand Created          t=0
  24,   //  1  Project Created                  +1d
  120,  //  2  BOM Defined                      +5d
  72,   //  3  BOM Frozen At DS1                +3d
  24,   //  4  Build Quantity Defined           +1d
  24,   //  5  Material Demand Specified        +1d
  48,   //  6  Material Ordered                 +2d
  72,   //  7  Supplier Confirmed Order         +3d
  336,  //  8  Material ETA Changed             +14d  ⚠ disruption
  0,    //  9  Material Shortage Identified     derived
  120,  // 10  Engineering Change Raised        +5d
  72,   // 11  Engineering Change Approved      +3d
  48,   // 12  BOM Frozen At DS2                +2d
  24,   // 13  Engineering Release Approved     +1d
  24,   // 14  Build Priority Set               +1d
  24,   // 15  Build Plan Updated               +1d
  24,   // 16  Build Plan Locked                +1d
  24,   // 17  Build Released To Site           +1d
  48,   // 18  Production Line Booked           +2d
  120,  // 19  Material Received At Site        +5d
  0,    // 20  Material Kit Completed           derived
  24,   // 21  Production Started               +1d
  72,   // 22  Board Test Passed                +3d
  48,   // 23  First Article Inspection Passed  +2d
  24,   // 24  Build Reached RTD                +1d
  24,   // 25  Units Picked And Packed          +1d
  24,   // 26  Shipment Dispatched              +1d
  96,   // 27  Unit Received By Customer        +4d transit
];

export function businessTimeForStep(stepIdx: number): Date {
  let hours = 0;
  for (let i = 0; i <= stepIdx && i < STEP_DURATIONS_HOURS.length; i++) {
    hours += STEP_DURATIONS_HOURS[i] ?? 0;
  }
  return new Date(SIM_BASE_MS + hours * 3_600_000);
}

// Module-level "current simulated time" — set by the stepper before each
// step body runs, read by emit() when it writes the EventLog row. Cleared
// after the step so out-of-band emits (e.g. derived-event subscribers
// firing slightly later) fall back to "now" rather than reusing a stale
// step time.
let activeBusinessAt: Date | null = null;
export function setBusinessClock(d: Date | null) { activeBusinessAt = d; }
export function getBusinessClock(): Date | null { return activeBusinessAt; }
