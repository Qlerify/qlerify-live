// Cohort statistics for the merged-flow view. The goal metric everywhere is
// DISTINCT-CASE COVERAGE per step — how many cases fired an event at least once
// out of a stated denominator — never total firings, which double-count repeats
// (a case can legitimately fire "Meeting Held" nine times). Raw firings survive
// only as tooltip detail.
//
// Everything here is pure client-side math over the already-loaded payloads
// (/sim/flow-by-case + /sim/cases + /sim/events); no endpoint computes coverage.
import type { EventDef, FlowCaseRow } from "./types.ts"
import type { CaseRecord } from "./ovquery.ts"

export type FlowEdgeRef = { from: string; to: string }

// The same edge set the layout draws: declared predecessors. A linear model
// with no predecessors draws no edges, so edge stats are empty there too.
export const flowEdgesOf = (events: EventDef[]): FlowEdgeRef[] => {
  const refs = new Set(events.map((e) => e.ref))
  const edges: FlowEdgeRef[] = []
  for (const e of events) {
    for (const p of e.predecessors || []) {
      if (refs.has(p)) {
        edges.push({ from: p, to: e.ref })
      }
    }
  }
  return edges
}

// Index (in declared order) of the last step this case fired; -1 = none.
export const furthestIndex = (events: EventDef[], fr: FlowCaseRow | null): number => {
  if (!fr) {
    return -1
  }
  const counts = fr.counts || {}
  for (let i = events.length - 1; i >= 0; i--) {
    if ((counts[events[i]!.ref] || 0) > 0) {
      return i
    }
  }
  return -1
}

// Number of order violations for the case: edges whose target fired while the
// source never did. Nothing server-side detects this (currentRef assumes linear
// progress), so the client is the only place it can surface.
export const skippedEdgeCount = (events: EventDef[], fr: FlowCaseRow | null): number => {
  if (!fr) {
    return 0
  }
  const counts = fr.counts || {}
  let n = 0
  for (const { from, to } of flowEdgesOf(events)) {
    if ((counts[to] || 0) > 0 && (counts[from] || 0) === 0) {
      n++
    }
  }
  return n
}

// Steps this case fired more than once. Repeat firings are legitimate business
// activity (multiple meetings), NOT rework — callers must present them neutrally.
export const multiFiredCount = (fr: FlowCaseRow | null): number => {
  if (!fr) {
    return 0
  }
  let n = 0
  for (const ref in fr.counts || {}) {
    if (fr.counts[ref]! > 1) {
      n++
    }
  }
  return n
}

export type EdgeStat = { from: string; to: string; waiting: number; outOfOrder: number }

export type CohortStats = {
  /** The one denominator every fraction shares: all cases in the slice. */
  denom: number
  /** Distinct cases that fired the ref at least once. */
  coveredByRef: Record<string, number>
  /** Total firings incl. repeats — tooltip detail only. */
  firingsByRef: Record<string, number>
  totalFirings: number
  /** Partition of ALL `denom` cases by furthest step reached (declared order);
   * index aligned with `events`. Sums with `notStarted` to exactly `denom`. */
  furthest: number[]
  notStarted: number
  edges: EdgeStat[]
  anomalies: { skipped: number; neverStarted: number; uncorrelated: number; multiFired: number }
}

export const cohortStats = (events: EventDef[], recs: CaseRecord[]): CohortStats => {
  const coveredByRef: Record<string, number> = {}
  const firingsByRef: Record<string, number> = {}
  const furthest = events.map(() => 0)
  const edgeRefs = flowEdgesOf(events)
  const edges: EdgeStat[] = edgeRefs.map((e) => ({ ...e, waiting: 0, outOfOrder: 0 }))
  let totalFirings = 0
  let notStarted = 0
  let skipped = 0
  let uncorrelated = 0
  let multiFired = 0

  for (const r of recs) {
    const counts = r.fr?.counts || {}
    const fi = furthestIndex(events, r.fr)
    if (fi < 0) {
      notStarted++
    } else {
      furthest[fi] = (furthest[fi] || 0) + 1
    }
    if (r.fr && !r.row) {
      uncorrelated++
    }
    let multi = false
    for (const ref in counts) {
      const n = counts[ref]!
      if (n > 0) {
        coveredByRef[ref] = (coveredByRef[ref] || 0) + 1
        firingsByRef[ref] = (firingsByRef[ref] || 0) + n
        totalFirings += n
        if (n > 1) {
          multi = true
        }
      }
    }
    if (multi) {
      multiFired++
    }
    let violated = false
    for (let i = 0; i < edges.length; i++) {
      const fired = (counts[edges[i]!.to] || 0) > 0
      const srcFired = (counts[edges[i]!.from] || 0) > 0
      if (srcFired && !fired) {
        edges[i]!.waiting++
      } else if (fired && !srcFired) {
        edges[i]!.outOfOrder++
        violated = true
      }
    }
    if (violated) {
      skipped++
    }
  }

  return {
    denom: recs.length,
    coveredByRef,
    firingsByRef,
    totalFirings,
    furthest,
    notStarted,
    edges,
    anomalies: { skipped, neverStarted: notStarted, uncorrelated, multiFired },
  }
}

// --- Period detection -------------------------------------------------------
//
// Cycle case ids are engine-composed as "<subject>@<period>" (src/twin/period.ts
// cycleId), with canonical period formats: quarter "2026Q3" · month "2026-08" ·
// week "2026-W32" · year "2026". When one period dominates the slice, the view
// is a synchronized cohort and pace-vs-calendar becomes meaningful: every case
// shares one birthday, so ONLY position-vs-day-N discriminates. All boundary
// math is UTC, mirroring the server's bucketing.

export type Period = {
  label: string
  start: number
  end: number
  days: number
  /** Fraction of the slice's cases carrying this period. */
  share: number
  /** All periods seen in the slice, most frequent first. */
  candidates: { label: string; count: number }[]
}

export const parsePeriodToken = (tok: string): { start: number; end: number } | null => {
  let m = /^(\d{4})Q([1-4])$/.exec(tok)
  if (m) {
    const y = Number(m[1])
    const q = Number(m[2])
    return { start: Date.UTC(y, (q - 1) * 3, 1), end: Date.UTC(y, q * 3, 1) }
  }
  m = /^(\d{4})-(\d{2})$/.exec(tok)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    return mo >= 1 && mo <= 12 ? { start: Date.UTC(y, mo - 1, 1), end: Date.UTC(y, mo, 1) } : null
  }
  m = /^(\d{4})-W(\d{2})$/.exec(tok)
  if (m) {
    const w = Number(m[2])
    if (w < 1 || w > 53) {
      return null
    }
    // ISO week 1 contains Jan 4; back up to that week's Monday.
    const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4))
    const day = jan4.getUTCDay() || 7
    const start = Date.UTC(Number(m[1]), 0, 4 - (day - 1) + (w - 1) * 7)
    return { start, end: start + 7 * 86400000 }
  }
  m = /^(\d{4})$/.exec(tok)
  if (m) {
    return { start: Date.UTC(Number(m[1]), 0, 1), end: Date.UTC(Number(m[1]) + 1, 0, 1) }
  }
  return null
}

/** Dominant period of the slice, or null when none reaches `minShare` (mixed
 * cycles — the caller should offer narrowing instead of drawing a pace mark). */
export const periodFromRecords = (recs: CaseRecord[], minShare = 0.6): Period | null => {
  const seen = new Map<string, number>()
  for (const r of recs) {
    const at = r.id.lastIndexOf("@")
    if (at <= 0) {
      continue
    }
    const tok = r.id.slice(at + 1)
    if (parsePeriodToken(tok)) {
      seen.set(tok, (seen.get(tok) || 0) + 1)
    }
  }
  if (!seen.size || !recs.length) {
    return null
  }
  const candidates = [...seen.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
  const top = candidates[0]!
  const share = top.count / recs.length
  if (share < minShare) {
    return null
  }
  const bounds = parsePeriodToken(top.label)!
  return {
    label: top.label,
    start: bounds.start,
    end: bounds.end,
    days: Math.round((bounds.end - bounds.start) / 86400000),
    share,
    candidates,
  }
}

/** 1-based day of the period containing `now`, clamped into [1, days]. */
export const dayOfPeriod = (p: Period, now: number): number =>
  Math.min(p.days, Math.max(1, Math.floor((now - p.start) / 86400000) + 1))

/** All periods present in the slice (for "mixed cycles" narrowing chips). */
export const periodCandidates = (recs: CaseRecord[]): { label: string; count: number }[] => {
  const seen = new Map<string, number>()
  for (const r of recs) {
    const at = r.id.lastIndexOf("@")
    if (at <= 0) {
      continue
    }
    const tok = r.id.slice(at + 1)
    if (parsePeriodToken(tok)) {
      seen.set(tok, (seen.get(tok) || 0) + 1)
    }
  }
  return [...seen.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
}
