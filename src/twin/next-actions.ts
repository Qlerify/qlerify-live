// Next actions: "what can happen next, per case, per role" — the deterministic
// candidate set behind the To do tab, the case-detail "Next step" banner, and
// (Phase B) the AI-ranked recommendations. Pure planner + thin I/O wrapper,
// same split as derive.ts / correlate.ts.
//
// The frontier rule is OR-join with bypass exclusion, matching how this repo
// already reads the `follows` DAG: branches are ALTERNATIVES (branchTotal reads
// an uncommitted run as "the longest alternative still open"), the simulator
// writes skip-marker EventLog rows, and ingested data legitimately skips steps.
// So an event is a ready todo iff:
//   1. it is a real step — has a command (not an inert flow marker) and is not
//      a coupledTo satellite (satellites fire with their predecessor in the
//      same tick; they are never an independent human action);
//   2. it has not fired (ANY EventLog row with its ref counts, including skip
//      markers — the same rule genericCurrentStep uses);
//   3. at least one predecessor has fired — or it has no predecessors and the
//      case has fired nothing at all (reason "start");
//   4. it is not BYPASSED: no transitive successor has fired. This one sweep
//      handles both alternative branches (the case took the other branch) and
//      skipped-ahead data (the flow already moved past this step).
// A frontier can hold SEVERAL events (both heads after a fork) — that is the
// correct answer, not a bug: each is a legitimate candidate next action.

import { prisma } from "../db.js";
import type { Ontology } from "../ontology/model.js";
import { getOntology } from "../ontology/model.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";

export type NextActionReason = "start" | "ready";

/** One case's fired history, the pure planner's only input besides the model.
 * `times` (per-ref last business/recorded time) is optional — it only enriches
 * the deterministic `why` phrasing. */
export interface CaseState {
  firedRefs: Set<string>;
  /** Last business activity (recorded time as fallback); null = no timestamps. */
  lastAt: Date | null;
  times?: Map<string, Date>;
}

export interface NextAction {
  caseId: string;
  eventKey: string;
  eventRef: string;
  eventName: string;
  commandName: string;
  /** The lane that owns the step — the candidate group, never a specific user. */
  role: string;
  boundedContext: string;
  aggregateRoot: string;
  reason: NextActionReason;
  /** One-sentence deterministic "why am I seeing this". */
  why: string;
  lastAt: string | null;
  dwellDays: number | null;
  stale: boolean;
}

export interface NextActionsResult {
  actions: NextAction[];
  /** Pre-cap count (after role/case filters). */
  totalActions: number;
  /** Distinct cases with at least one open action (after filters). */
  totalCases: number;
  /** role → open-action count over the UNfiltered set (picker badges). */
  byRole: Record<string, number>;
  generatedAt: string;
  /** `${eventCount}:${maxOccurredAtISO}` — moves on every emit/wipe. Shared
   * with the stored AI recommendations for lazy invalidation. */
  watermark: string;
}

const DEFAULT_STALE_DAYS = 3;
const MS_PER_DAY = 86_400_000;

/** PURE: the frontier of every case, sorted most-attention-needed first
 * (stale before fresh, then oldest activity, then model order). No I/O, no
 * getOntology() — the ontology-singleton-free signature is deliberate so an
 * out-of-band caller (a future digest job) can feed models loaded locally,
 * the way org-dashboard does. */
export function planNextActions(
  ont: Ontology,
  cases: Map<string, CaseState>,
  opts: { now?: Date; staleDays?: number } = {},
): NextAction[] {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const topo = ont.topologicalOrder();
  // Real steps only: a command-less event is an inert diagram marker and a
  // coupledTo satellite completes with its predecessor — neither is a todo.
  // `derived` (rules-engine) events STAY in: they still have to happen, and
  // hiding them would make a case waiting on an automatic step look done.
  const isStep = (key: string): boolean => {
    const e = ont.eventByKey(key);
    return !!e && !!e.commandName && !e.coupledTo;
  };
  const refOf = (key: string): string => ont.eventByKey(key)?.ref ?? `#/domainEvents/${key}`;

  const out: NextAction[] = [];
  for (const [caseId, state] of cases) {
    const fired = state.firedRefs;
    // A predecessor counts as satisfied when it — or any anchor along its
    // coupledTo chain — has fired: satellites fire together with their anchor
    // only on the sim/derive paths, while a direct command post fires just the
    // anchor. Without the chain walk, a satellite predecessor that never got
    // its own EventLog row would wedge every successor out of the frontier.
    const predSatisfied = (key: string): boolean => {
      const seen = new Set<string>();
      for (let k: string | undefined = key; k && !seen.has(k); k = ont.eventByKey(k)?.coupledTo) {
        seen.add(k);
        const pe = ont.eventByKey(k);
        if (pe && fired.has(pe.ref)) return true;
      }
      return false;
    };
    // Bypass sweep: descendantFired[key] = some transitive successor fired.
    // Reverse topological order makes it one pass.
    const descendantFired = new Map<string, boolean>();
    for (let i = topo.length - 1; i >= 0; i--) {
      const key = topo[i]!;
      let hit = false;
      for (const s of ont.successorsOf(key)) {
        if (fired.has(refOf(s)) || descendantFired.get(s)) { hit = true; break; }
      }
      descendantFired.set(key, hit);
    }

    for (const key of topo) {
      if (!isStep(key)) continue;
      const e = ont.eventByKey(key)!;
      if (fired.has(e.ref)) continue;
      if (descendantFired.get(key)) continue;
      let reason: NextActionReason;
      if (e.predecessors.length === 0) {
        if (fired.size > 0) continue; // a second entry point on an active case is not a todo
        reason = "start";
      } else {
        if (!e.predecessors.some(predSatisfied)) continue;
        reason = "ready";
      }
      const dwellDays = state.lastAt ? Math.max(0, Math.floor((now.getTime() - state.lastAt.getTime()) / MS_PER_DAY)) : null;
      out.push({
        caseId,
        eventKey: e.key,
        eventRef: e.ref,
        eventName: e.name,
        commandName: e.commandName,
        role: e.role,
        boundedContext: e.boundedContext,
        aggregateRoot: e.aggregateRoot,
        reason,
        why: whyOf(ont, e.key, reason, state, now),
        lastAt: state.lastAt ? state.lastAt.toISOString() : null,
        dwellDays,
        stale: dwellDays !== null && dwellDays >= staleDays,
      });
    }
  }

  // Worst-first, the drill.ts triage contract: stale before fresh, oldest
  // activity first (unknown-activity cases sink within their group), model
  // order as the stable tiebreaker.
  const linearIndex = new Map(ont.linearOrder().map((k, i) => [k, i]));
  out.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? -1 : 1;
    const ta = a.lastAt ? Date.parse(a.lastAt) : Number.POSITIVE_INFINITY;
    const tb = b.lastAt ? Date.parse(b.lastAt) : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return (linearIndex.get(a.eventKey) ?? 0) - (linearIndex.get(b.eventKey) ?? 0);
  });
  return out;
}

/** The one-sentence deterministic rationale. Names the fired predecessor that
 * unblocked the step (the latest-fired one when times are known). */
function whyOf(ont: Ontology, key: string, reason: NextActionReason, state: CaseState, now: Date): string {
  const e = ont.eventByKey(key)!;
  if (reason === "start") return `Nothing has fired yet — "${e.name}" (${e.role}) starts this case.`;
  let pred = e.predecessors.find((p) => state.firedRefs.has(ont.eventByKey(p)?.ref ?? ""));
  let predAt: Date | undefined;
  for (const p of e.predecessors) {
    const pe = ont.eventByKey(p);
    if (!pe || !state.firedRefs.has(pe.ref)) continue;
    const at = state.times?.get(pe.ref);
    if (at && (!predAt || at > predAt)) { pred = p; predAt = at; }
  }
  const predName = ont.eventByKey(pred ?? "")?.name ?? pred ?? "the previous step";
  if (predAt) {
    const days = Math.max(0, Math.floor((now.getTime() - predAt.getTime()) / MS_PER_DAY));
    const ago = days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
    return `"${predName}" fired ${ago} — "${e.name}" (${e.role}) has been unblocked since.`;
  }
  return `"${predName}" has fired — "${e.name}" (${e.role}) is unblocked.`;
}

/** `${eventCount}:${maxOccurredAtISO}` for the active workflow — the cheap data
 * watermark. Every emit bumps the count; a model apply wipes the EventLog and
 * resets it. Exported for the Phase B freshness check. */
export async function eventLogWatermark(): Promise<string> {
  const agg = await prisma.eventLog.aggregate({
    where: eventLogOrgWhere(),
    _count: { _all: true },
    _max: { occurredAt: true },
  });
  return `${agg._count._all}:${agg._max.occurredAt ? agg._max.occurredAt.toISOString() : ""}`;
}

export interface NextActionsQuery {
  role?: string;
  caseId?: string;
  /** Cap on returned actions; 0/null lifts it (the /sim ?limit=0 idiom). */
  limit?: number | null;
  staleDays?: number;
}

/** Thin I/O wrapper: ONE grouped EventLog query (the /sim/flow-by-case shape —
 * never per-case round trips) → pure planner → filter/cap. */
export async function computeNextActions(opts: NextActionsQuery = {}): Promise<NextActionsResult> {
  const ont = getOntology();
  // Watermark FIRST: an emit landing between this read and the groupBy below
  // can only make a stored AI ranking look stale (harmless) — reading it after
  // the rows could stamp a blob "fresh" for data it never saw.
  const watermark = await eventLogWatermark();
  const rows = await prisma.eventLog.groupBy({
    by: ["caseId", "eventRef"],
    where: { caseId: opts.caseId ?? { not: null }, ...eventLogOrgWhere() },
    _max: { businessAt: true, occurredAt: true },
  });
  const cases = new Map<string, CaseState>();
  // Pass 1 — business time only. occurredAt is ~ingestion wall-clock for
  // derived/replayed rows (re-stamped on every reingest), so mixing it into a
  // case that HAS business time would reset dwell to 0 and invert the triage
  // sort for exactly the oldest, most-stuck cases.
  const hasBusiness = new Set<string>();
  for (const r of rows) {
    const id = r.caseId as string;
    let c = cases.get(id);
    if (!c) { c = { firedRefs: new Set(), lastAt: null, times: new Map() }; cases.set(id, c); }
    c.firedRefs.add(r.eventRef);
    const b = r._max?.businessAt ?? null;
    if (b) {
      hasBusiness.add(id);
      c.times!.set(r.eventRef, b);
      if (!c.lastAt || b > c.lastAt) c.lastAt = b;
    }
  }
  // Pass 2 — recorded-time fallback per CASE (never per ref): only a case with
  // no business time anywhere gets its dwell from recorded order, so each case
  // stays on a single timescale.
  for (const r of rows) {
    const id = r.caseId as string;
    if (hasBusiness.has(id)) continue;
    const c = cases.get(id)!;
    const o = r._max?.occurredAt ?? null;
    if (o) {
      c.times!.set(r.eventRef, o);
      if (!c.lastAt || o > c.lastAt) c.lastAt = o;
    }
  }
  const all = planNextActions(ont, cases, { staleDays: opts.staleDays });
  const byRole: Record<string, number> = {};
  for (const a of all) byRole[a.role] = (byRole[a.role] ?? 0) + 1;
  const filtered = opts.role ? all.filter((a) => a.role === opts.role) : all;
  const cap = opts.limit === undefined ? 500 : opts.limit;
  const actions = cap && cap > 0 ? filtered.slice(0, cap) : filtered;
  return {
    actions,
    totalActions: filtered.length,
    totalCases: new Set(filtered.map((a) => a.caseId)).size,
    byRole,
    generatedAt: new Date().toISOString(),
    watermark,
  };
}
