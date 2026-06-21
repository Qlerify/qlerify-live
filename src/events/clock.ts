// Business clock override.
//
// Every EventLog row carries two timestamps:
//   occurredAt = real wall-clock (when the row was recorded)
//   businessAt = the event's business date
//
// businessAt is resolved in events/bus.ts (emit) from a date attribute carried
// in the event's own data — so per-step durations follow the data, not any
// hard-coded schedule. This module only holds an optional *override*: a caller
// that already knows the date for the events it is about to emit (e.g. an
// adapter replaying real source records) can pin it via setBusinessClock(date),
// and emit() prefers it over the payload-derived date. Cleared after the step so
// out-of-band emits fall back to the derived date rather than reusing a stale one.

let activeBusinessAt: Date | null = null;
export function setBusinessClock(d: Date | null) { activeBusinessAt = d; }
export function getBusinessClock(): Date | null { return activeBusinessAt; }
