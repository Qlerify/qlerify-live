import type { EventDef, Instance, LogEntry, Meta, Row } from "./types.ts"

// Platform/bookkeeping columns we never surface as business fields.
export const GEN_HIDDEN = new Set(["version", "createdAt", "updatedAt", "_provenance"])

export const parsePayload = (s?: string): Row => {
  try {
    const o = JSON.parse(s ?? "null")
    return o && typeof o === "object" ? o : {}
  } catch {
    return {}
  }
}

const eventRefIndex = (events: EventDef[]) => {
  const m = new Map<string, number>()
  events.forEach((e, i) => m.set(e.ref, i))
  return m
}

// id → { agg, row } over the LIVE instance, for static-field carry-over.
const liveRowsById = (inst: Instance) => {
  const m = new Map<string, { agg: string; row: Row }>()
  if (inst.root && inst.root.id != null) {
    m.set(String(inst.root.id), { agg: inst.rootAggregate || "", row: inst.root })
  }
  for (const [agg, rows] of Object.entries(inst.entities || {})) {
    for (const row of rows || []) {
      if (row.id != null) {
        m.set(String(row.id), { agg, row })
      }
    }
  }
  return m
}

// Fold the payloads of the log entries the predicate accepts. `everCarried` lets
// us tell a column a LATER command sets (blank — "not yet established") from a
// time-invariant one carried over from the live row.
const reconstructInstance = (
  instance: Instance,
  includeIdx: (idx: number) => boolean,
  everCarried: Map<string, Set<string>>,
  live: Map<string, { agg: string; row: Row }>,
  refIdx: Map<string, number>,
  chrono: LogEntry[],
): Instance => {
  const folded = new Map<string, { agg: string; row: Row }>()
  for (const ev of chrono) {
    if (!ev.aggregateId) {
      continue
    }
    const idx = refIdx.get(ev.eventRef)
    if (idx == null || !includeIdx(idx)) {
      continue
    }
    const p = parsePayload(ev.payload)
    if (Object.keys(p).length === 0) {
      continue
    }
    const id = String(ev.aggregateId)
    let cur = folded.get(id)
    if (!cur) {
      cur = { agg: (ev as LogEntry & { aggregateRoot?: string }).aggregateRoot || "", row: {} }
      folded.set(id, cur)
    }
    Object.assign(cur.row, p) // later (chronological) values win
  }

  const entities: Record<string, Row[]> = {}
  let root: Row | null = null
  for (const [id, { agg, row: asOf }] of folded) {
    const liveRow = live.get(id)?.row || {}
    const carried = everCarried.get(id) || new Set<string>()
    const out: Row = { id }
    const cols = new Set([...Object.keys(liveRow), ...Object.keys(asOf)])
    for (const c of cols) {
      if (c === "id") {
        continue
      }
      if (c in asOf) {
        out[c] = asOf[c]
      } else if (carried.has(c)) {
        out[c] = null
      } else {
        out[c] = liveRow[c]
      }
    }
    if (agg === instance.rootAggregate && id === String(instance.root?.id ?? "")) {
      root = out
    } else {
      ;(entities[agg] ??= []).push(out)
    }
  }

  return {
    instanceId: instance.instanceId,
    rootAggregate: instance.rootAggregate,
    root,
    entities,
    events: instance.events,
  }
}

// The instance to render, plus the baseline to diff against: live, or — when a
// step is selected — the state as of that step and the state just before it.
export const activeDetailInstance = (
  instance: Instance | null,
  log: LogEntry[],
  events: EventDef[],
  selectedStep: number | null,
): { inst: Instance; asOfPrev: Instance | null } => {
  if (!instance) {
    return { inst: { instanceId: "" }, asOfPrev: null }
  }
  if (selectedStep == null) {
    return { inst: instance, asOfPrev: null }
  }

  const refIdx = eventRefIndex(events)
  const chrono = log.slice().reverse() // log is newest-first

  const everCarried = new Map<string, Set<string>>()
  for (const ev of chrono) {
    if (!ev.aggregateId) {
      continue
    }
    const p = parsePayload(ev.payload)
    const id = String(ev.aggregateId)
    let set = everCarried.get(id)
    if (!set) {
      set = new Set()
      everCarried.set(id, set)
    }
    for (const k of Object.keys(p)) {
      set.add(k)
    }
  }

  const live = liveRowsById(instance)
  // Every firing of the selected event shares the declared index, so "≤ sel"
  // includes them all and "< sel" excludes them all — the diff is the net effect.
  return {
    inst: reconstructInstance(instance, (idx) => idx <= selectedStep, everCarried, live, refIdx, chrono),
    asOfPrev: reconstructInstance(instance, (idx) => idx < selectedStep, everCarried, live, refIdx, chrono),
  }
}

// Blank-tolerant: a value that was "not yet established" (null) and later set
// reads as a change, while null/undefined/"" never differ among themselves.
const asOfBlank = (v: unknown) => v === null || v === undefined || v === ""
const asOfNorm = (v: unknown) => (asOfBlank(v) ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))

export const asOfChangedFields = (row: Row, prev: Row | undefined): Set<string> => {
  const changed = new Set<string>()
  const cols = new Set(Object.keys(row))
  if (prev) {
    for (const k of Object.keys(prev)) {
      cols.add(k)
    }
  }
  for (const k of cols) {
    if (k === "id" || GEN_HIDDEN.has(k)) {
      continue
    }
    if (asOfNorm(row[k]) !== asOfNorm(prev ? prev[k] : undefined)) {
      changed.add(k)
    }
  }
  return changed
}

// Every row in the run, tagged with its aggregate. The root is listed once.
export const genAllRows = (inst: Instance, meta: Meta) => {
  const out: { agg: string; row: Row }[] = []
  const rootId = inst.root?.id
  if (inst.root) {
    out.push({ agg: meta.rootAggregate, row: inst.root })
  }
  for (const [agg, rows] of Object.entries(inst.entities || {})) {
    for (const row of rows || []) {
      if (agg === meta.rootAggregate && row.id === rootId) {
        continue
      }
      out.push({ agg, row })
    }
  }
  return out
}

// aggregate → bounded context, read off the run's event log, so each card can
// show which system the data came from.
export const genBcByAgg = (inst: Instance): Record<string, string> => {
  const map: Record<string, string> = {}
  for (const e of inst.events || []) {
    const agg = (e as LogEntry & { aggregateRoot?: string }).aggregateRoot
    if (agg && e.boundedContext && !map[agg]) {
      map[agg] = e.boundedContext
    }
  }
  return map
}

// An embedded-structure field → rows for a small table: an array of objects, or a
// single object (a value object) as one row. Scalars return null (rendered inline).
export const genParseRows = (v: unknown): Row[] | null => {
  let parsed = v
  if (typeof v === "string") {
    const t = v.trim()
    if (t[0] !== "[" && t[0] !== "{") {
      return null
    }
    try {
      parsed = JSON.parse(t)
    } catch {
      return null
    }
  }
  if (Array.isArray(parsed)) {
    return parsed.length && parsed[0] && typeof parsed[0] === "object" ? (parsed as Row[]) : null
  }
  if (parsed && typeof parsed === "object") {
    return [parsed as Row]
  }
  return null
}

// The diff baseline: the reconstruction just before the selected event's firings,
// else the live pre-step snapshot.
export const genPrevRow = (
  baseline: Instance | null,
  agg: string,
  id: unknown,
): Row | undefined => {
  if (!baseline || id == null) {
    return undefined
  }
  if (agg === baseline.rootAggregate && baseline.root && baseline.root.id === id) {
    return baseline.root
  }
  return (baseline.entities?.[agg] || []).find((r) => r.id === id)
}

// The aggregate the most recent event touched. This is the baseline on the FIRST
// view of a run: the create event fires server-side at start, so there is no
// client-side pre-step snapshot — without this, that first step highlights nothing.
const genLastTouched = (log: LogEntry[]) => {
  const last = log[0]
  const agg = last ? (last as LogEntry & { aggregateRoot?: string }).aggregateRoot : null
  if (!last || !agg || !last.aggregateId) {
    return null
  }
  return { agg, id: String(last.aggregateId) }
}

export type DiffCtx = {
  baseline: Instance | null
  hasBaseline: boolean
  selected: boolean
  log: LogEntry[]
}

export const genRowChanged = (ctx: DiffCtx, agg: string, row: Row): boolean => {
  const prev = genPrevRow(ctx.baseline, agg, row.id)
  if (ctx.selected) {
    return asOfChangedFields(row, prev).size > 0
  }
  if (ctx.hasBaseline) {
    if (!prev) {
      return true // created by the last event
    }
    return JSON.stringify(prev) !== JSON.stringify(row)
  }
  const lt = genLastTouched(ctx.log)
  return !!lt && lt.agg === agg && row.id != null && String(row.id) === lt.id
}

export const genFieldChanged = (ctx: DiffCtx, agg: string, row: Row, field: string): boolean => {
  const prev = genPrevRow(ctx.baseline, agg, row.id)
  if (ctx.selected) {
    return asOfChangedFields(row, prev).has(field)
  }
  if (prev) {
    return JSON.stringify(prev[field]) !== JSON.stringify(row[field])
  }
  // New row (or no baseline): every business field is new.
  return genRowChanged(ctx, agg, row)
}

export const genPrevCollection = (ctx: DiffCtx, agg: string, row: Row, field: string): Row[] | null => {
  const prev = genPrevRow(ctx.baseline, agg, row.id)
  return prev ? genParseRows(prev[field]) : null
}

export const shortId = (id?: string) => {
  if (!id) {
    return "—"
  }
  return String(id).length > 14 ? String(id).slice(0, 8) + "…" : id
}
