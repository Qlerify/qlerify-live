// Shared query engine for the three Overview tabs (#flow, #rows, #list):
// free-text search, structured filters, multi-level sort, pagination and a
// column chooser — all combinable, all client-side over the full case set (the
// loaders fetch ?limit=0), and carried in the URL hash so any slice is
// shareable. Search/sort/filter state is SHARED across the tabs; page/pageSize
// (+ chosen columns for the List) are per-tab, with prefs in localStorage.
import { AUTH } from "./api.ts"
import { useStore } from "./store.ts"
import { attrSearchText, attrText, prettyEntity } from "./format.ts"
import { furthestIndex, multiFiredCount, parsePeriodToken, skippedEdgeCount } from "./cohort.ts"
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, createOv, pageSizesFor, setPref } from "./ovState.ts"
import type { OvActivity, OvFilter, OvSort, OvState, OvTab } from "./ovState.ts"
import type { CaseRow, EventDef, FlowCaseRow, NextAction, NextActionsResult, Row } from "./types.ts"

export { PAGE_SIZES, createOv }
export type { OvActivity, OvFilter, OvSort, OvState, OvTab }

// Default sort when the user hasn't chosen one: the List keeps the server's
// stable createdAt order; By-case keeps its "most recently active first".
const DEFAULT_SORT: Record<string, OvSort[]> = { list: [], rows: [{ key: "lastAt", dir: -1 }], flow: [], todo: [] }

// Same reserved set genericColumns/the server use, plus platform columns that
// must never surface as user-facing attributes.
const RESERVED = new Set([
  "id",
  "version",
  "createdAt",
  "updatedAt",
  "status",
  "progress",
  "total",
  "lastEvent",
  "dwellSeconds",
  "organization_id",
])

export const ov = () => useStore.getState().ov

// A workflow switch is SPA-style (no reload) and columns/prefs are model-
// specific — drop the query state when the scope changes so one workflow's
// filters/columns never bleed into another's.
export const ensureOvScope = () => {
  const cur = useStore.getState().ov
  const wf = AUTH.workflow() || "-"
  if (cur.wf !== wf) {
    useStore.getState().set({ ov: createOv() })
  }
}

export const patchOv = (p: Partial<OvState>) => {
  useStore.getState().set({ ov: { ...useStore.getState().ov, ...p } })
}

export const setOvPage = (tab: "list" | "rows", page: number) => {
  const cur = ov()
  patchOv({ tab: { ...cur.tab, [tab]: { ...cur.tab[tab], page } } })
}

export const setOvPageSize = (tab: "list" | "rows", pageSize: number) => {
  const cur = ov()
  setPref(`${tab}.pageSize`, pageSize)
  patchOv({ tab: { ...cur.tab, [tab]: { page: 0, pageSize } } })
}

export const setOvCols = (cols: string[] | null) => {
  setPref("cols", cols)
  patchOv({ cols })
}

// Rolling recency windows for the Activity quick-filter. Days use calendar-day
// math; months/years shift the calendar field so "last 3 months" tracks the
// month boundary, not a flat 90 days.
export const ACTIVITY_WINDOWS: [string, string][] = [
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["3mo", "Last 3 months"],
  ["12mo", "Last 12 months"],
]
export const ACTIVITY_FIELD: Record<string, string> = { startedAt: "Started", lastAt: "Active" }

const windowCutoff = (within: string, nowMs: number): number | null => {
  if (!within) {
    return null
  }
  const d = new Date(nowMs)
  switch (within) {
    case "24h":
      d.setDate(d.getDate() - 1)
      break
    case "7d":
      d.setDate(d.getDate() - 7)
      break
    case "30d":
      d.setDate(d.getDate() - 30)
      break
    case "3mo":
      d.setMonth(d.getMonth() - 3)
      break
    case "12mo":
      d.setFullYear(d.getFullYear() - 1)
      break
    default:
      return null
  }
  return d.getTime()
}

export const activityLabel = (a: OvActivity) => {
  const w = ACTIVITY_WINDOWS.find(([v]) => v === a.within)
  return w ? `${ACTIVITY_FIELD[a.field] || "Active"} · ${w[1].toLowerCase()}` : ""
}

// The active-tab key for the current view ("dashboard" renders the List).
export const ovTabForView = (view: string): OvTab | null => {
  if (view === "dashboard") {
    return "list"
  }
  return view === "flow" || view === "rows" || view === "todo" ? view : null
}

// True when the query narrows the case set (sort alone doesn't).
export const ovActive = () => {
  const o = ov()
  return !!(o.q.trim() || o.prog || o.activity?.within || o.filters.some((f) => String(f.value ?? "") !== ""))
}

// One record per case: `row` is the root-aggregate row, `fr` the flow row.
// Either side may be missing (a case with no events yet has no fr; an ingested
// log may reference a purged row).
export type CaseRecord = { id: string; row: CaseRow | null; fr: FlowCaseRow | null }

export const caseRecords = (): CaseRecord[] => {
  const s = useStore.getState()
  const out: CaseRecord[] = []
  const byId = new Map<string, CaseRecord>()
  for (const row of s.cases || []) {
    const rec: CaseRecord = { id: String(row.id), row, fr: null }
    out.push(rec)
    byId.set(rec.id, rec)
  }
  for (const fr of s.flowRows?.cases || []) {
    const id = String(fr.caseId)
    const rec = byId.get(id)
    if (rec) {
      rec.fr = fr
    } else {
      out.push({ id, row: null, fr })
    }
  }
  return out
}

// Steps done = CURRENT-model events this case fired (same rule cohortStats
// uses), so the flow view's counters and their drilled worklists agree. The
// server's row.progress counts ALL fired refs — including ones removed from the
// model — and is kept only as the fallback for cases with no flow row (which,
// with ?limit=0 loads, means cases with no events at all).
const stepsDone = (r: CaseRecord) => {
  if (r.fr) {
    const counts = r.fr.counts || {}
    let n = 0
    for (const e of useStore.getState().events || []) {
      if ((counts[e.ref] || 0) > 0) {
        n++
      }
    }
    return n
  }
  return r.row && typeof r.row.progress === "number" ? r.row.progress : 0
}

const stepsTotal = (r: CaseRecord) => {
  if (r.row && typeof r.row.total === "number" && r.row.total > 0) {
    return r.row.total
  }
  return (useStore.getState().events || []).length || 0
}

export const pctOf = (r: CaseRecord) => {
  const t = stepsTotal(r)
  return t > 0 ? Math.min(100, Math.round((stepsDone(r) / t) * 100)) : 0
}

export const progressCat = (r: CaseRecord) => {
  const done = stepsDone(r)
  if (done === 0) {
    return "none"
  }
  return done >= stepsTotal(r) ? "done" : "active"
}

export const PROG_LABEL: Record<string, string> = { none: "Not started", active: "In progress", done: "Done" }

type FieldDef = {
  label: string
  type: "number" | "string" | "date"
  attr?: string
  get: (r: CaseRecord) => unknown
}

const SYS_FIELDS: Record<string, FieldDef> = {
  progress: { label: "Progress %", type: "number", get: (r) => pctOf(r) },
  steps: { label: "Steps done", type: "number", get: (r) => stepsDone(r) },
  total: { label: "Steps total", type: "number", get: (r) => stepsTotal(r) },
  firings: { label: "Event firings", type: "number", get: (r) => (r.fr ? r.fr.firings : null) },
  status: { label: "Status", type: "string", get: (r) => r.row?.status ?? "" },
  id: { label: "ID", type: "string", get: (r) => r.id },
  lastEvent: { label: "Last event name", type: "string", get: (r) => r.row?.lastEvent?.eventName ?? "" },
  createdAt: { label: "Created", type: "date", get: (r) => r.row?.createdAt ?? null },
  updatedAt: { label: "Updated", type: "date", get: (r) => r.row?.updatedAt ?? null },
  startedAt: { label: "Started (business)", type: "date", get: (r) => r.fr?.startAt || null },
  lastAt: {
    label: "Last activity",
    type: "date",
    get: (r) => r.fr?.lastAt || (r.row?.lastEvent as { occurredAt?: string } | undefined)?.occurredAt || null,
  },
  // Conformance/coverage fields (numeric so drill-downs can filter ≥1 / =0 with
  // the stock operator set). All are derived client-side from the flow row.
  furthestStep: {
    label: "Furthest step #",
    type: "number",
    get: (r) => furthestIndex(useStore.getState().events || [], r.fr) + 1,
  },
  skippedSteps: {
    label: "Skipped steps (out of order)",
    type: "number",
    get: (r) => skippedEdgeCount(useStore.getState().events || [], r.fr),
  },
  multiFiredSteps: {
    label: "Multi-fired steps",
    type: "number",
    get: (r) => multiFiredCount(r.fr),
  },
  uncorrelated: {
    label: "Uncorrelated (no case row)",
    type: "number",
    get: (r) => (r.fr && !r.row ? 1 : 0),
  },
  // The exact period token from a cycle case id ("…@2026Q3" → "2026Q3"), empty
  // for non-cycle ids. An exact-match filter here narrows to ONE cycle — unlike
  // free-text search, which would substring-match date attributes too.
  cycle: {
    label: "Cycle",
    type: "string",
    get: (r) => {
      const at = r.id.lastIndexOf("@")
      if (at <= 0) {
        return ""
      }
      const tok = r.id.slice(at + 1)
      return parsePeriodToken(tok) ? tok : ""
    },
  },
  // Frontier fields from /sim/next-actions (polled with the rest): the case's
  // first unblocked step, its owning role, and how many steps are open at once
  // (0 = done or blocked). Sortable/filterable/URL-shareable like any field.
  nextStep: { label: "Next step", type: "string", get: (r) => nextActionsByCase().get(r.id)?.[0]?.eventName ?? "" },
  nextRole: { label: "Next role", type: "string", get: (r) => nextActionsByCase().get(r.id)?.[0]?.role ?? "" },
  readySteps: { label: "Ready steps", type: "number", get: (r) => nextActionsByCase().get(r.id)?.length ?? 0 },
}

// caseId → its open actions, memoized per payload reference (the store swaps
// the whole object on each load). Within one case the global sort degenerates
// to model order, so [0] is the earliest open step.
let naSrc: NextActionsResult | null = null
let naMap = new Map<string, NextAction[]>()
export const nextActionsByCase = (): Map<string, NextAction[]> => {
  const na = useStore.getState().nextActions
  if (na === naSrc) {
    return naMap
  }
  naSrc = na
  naMap = new Map()
  for (const a of na?.actions || []) {
    const arr = naMap.get(a.caseId)
    if (arr) {
      arr.push(a)
    } else {
      naMap.set(a.caseId, [a])
    }
  }
  return naMap
}

export const cycleFilter = (label: string): OvFilter => ({ field: "cycle", op: "eq", value: label })

// Per-step coverage fields ("e:<ref>" → that step's firing count for the case,
// 0 when never fired — never null, so `= 0` means "not through this step yet").
const stepFieldKey = (ref: string) => "e:" + ref
export const stepNotFiredFilter = (ref: string): OvFilter => ({ field: stepFieldKey(ref), op: "eq", value: "0" })
export const stepFiredFilter = (ref: string): OvFilter => ({ field: stepFieldKey(ref), op: "gte", value: "1" })

// Drill-downs land worst-first: least progressed, then stalest activity.
export const TRIAGE_SORT: OvSort[] = [
  { key: "progress", dir: 1 },
  { key: "lastAt", dir: 1 },
]

// Attribute columns: union of row keys across (up to) the first 100 records,
// minus reserved/platform keys — the candidate set for columns and filters.
export const attrColumns = (records: CaseRecord[]): string[] => {
  const keys: string[] = []
  const seen = new Set<string>()
  let n = 0
  for (const r of records) {
    if (!r.row) {
      continue
    }
    for (const k of Object.keys(r.row)) {
      if (seen.has(k) || RESERVED.has(k) || k.startsWith("_")) {
        continue
      }
      seen.add(k)
      keys.push(k)
    }
    if (++n >= 100) {
      break
    }
  }
  return keys
}

// Sniff an attribute's type from its first non-empty values so filters get the
// right input widget and sorts compare numerically when they can.
const sniffType = (records: CaseRecord[], key: string): FieldDef["type"] => {
  let seen = 0
  let num = 0
  let date = 0
  for (const r of records) {
    if (!r.row) {
      continue
    }
    const raw = r.row[key]
    if (raw == null || raw === "") {
      continue
    }
    const s = attrText(raw)
    if (s === "—" || s === "") {
      continue
    }
    seen++
    if (s !== "" && !isNaN(Number(s))) {
      num++
    } else if (/^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(Date.parse(s))) {
      date++
    }
    if (seen >= 25) {
      break
    }
  }
  if (seen && num === seen) {
    return "number"
  }
  if (seen && date === seen) {
    return "date"
  }
  return "string"
}

// Registry rebuilt once per pass (applyQuery/the toolbar both ensure it).
let fields: Record<string, FieldDef> | null = null
let attrKeys: string[] = []

export const ensureFields = (records: CaseRecord[]) => {
  const attrs = attrColumns(records)
  attrKeys = attrs
  const next: Record<string, FieldDef> = { ...SYS_FIELDS }
  for (const k of attrs) {
    next["a:" + k] = {
      label: prettyEntity(k),
      type: sniffType(records, k),
      attr: k,
      get: (r) => (r.row ? r.row[k] : null),
    }
  }
  // One numeric field per model step, so any step's coverage gap is filterable
  // (and lands in the URL hash — a drill-down is a shareable link).
  for (const e of useStore.getState().events || []) {
    const ref = e.ref
    next[stepFieldKey(ref)] = {
      label: `Fired: ${e.name}`,
      type: "number",
      get: (r) => r.fr?.counts?.[ref] ?? 0,
    }
  }
  fields = next
  return next
}

export const fieldDef = (key: string): FieldDef | null => (fields || SYS_FIELDS)[key] || null
export const attrFieldKeys = () => attrKeys

// Memoized search text per case, keyed by a cheap fingerprint.
const HAYSTACK = new Map<string, { fp: string; text: string }>()

const haystack = (r: CaseRecord) => {
  const fp = `${r.row?.updatedAt ?? ""}|${r.row?.progress ?? ""}|${r.fr?.lastAt ?? ""}|${r.fr?.firings ?? ""}`
  const hit = HAYSTACK.get(r.id)
  if (hit && hit.fp === fp) {
    return hit.text
  }
  const parts: string[] = [r.id]
  if (r.row) {
    for (const k of Object.keys(r.row)) {
      if (RESERVED.has(k) || k.startsWith("_")) {
        continue
      }
      // Deep-flatten so nested object/array leaves are searchable too.
      const s = attrSearchText(r.row[k])
      if (s) {
        parts.push(s)
      }
    }
    if (r.row.status) {
      parts.push(String(r.row.status))
    }
    const ev = r.row.lastEvent as { eventName?: string } | undefined
    if (ev?.eventName) {
      parts.push(ev.eventName)
    }
  }
  const text = parts.join("   ").toLowerCase()
  if (HAYSTACK.size > 5000) {
    HAYSTACK.clear()
  }
  HAYSTACK.set(r.id, { fp, text })
  return text
}

const numOf = (raw: unknown): number | null => {
  if (raw == null || raw === "") {
    return null
  }
  const n = Number(typeof raw === "number" ? raw : attrText(raw))
  return isFinite(n) ? n : null
}

// System date fields hold ISO strings; attribute dates may be wrapped values.
const attrTextIfNeeded = (def: FieldDef, raw: unknown) => (def.attr ? attrText(raw) : raw)

const matchFilter = (r: CaseRecord, f: OvFilter): boolean => {
  if (String(f.value ?? "") === "") {
    return true // incomplete row = no-op
  }
  const def = fieldDef(f.field)
  if (!def) {
    return true
  }
  const raw = def.get(r)

  if (def.type === "number") {
    const want = Number(f.value)
    if (!isFinite(want)) {
      return true
    }
    const v = numOf(raw)
    if (v == null) {
      return f.op === "neq"
    }
    switch (f.op) {
      case "eq":
        return v === want
      case "neq":
        return v !== want
      case "gte":
        return v >= want
      case "lte":
        return v <= want
      case "gt":
        return v > want
      case "lt":
        return v < want
    }
    return true
  }

  if (def.type === "date") {
    // Exact (in)equality compares the collapsed value as a string — the matrix
    // drills with the same value its segment grouped by, which may be full-ISO
    // and would NaN out of the day-window parse below.
    if (f.op === "eq" || f.op === "neq") {
      const sv = raw == null ? "" : String(attrTextIfNeeded(def, raw))
      return f.op === "eq" ? sv === String(f.value) : sv !== String(f.value)
    }
    // f.value is a calendar day (yyyy-mm-dd) from <input type=date>; parse it as
    // LOCAL midnight. Row values that are themselves date-only must parse on the
    // SAME local basis, or Date.parse("2020-01-21") (UTC midnight) lands a day
    // early in negative-offset zones. Full ISO timestamps carry their own zone.
    const start = Date.parse(f.value + "T00:00:00")
    if (!isFinite(start)) {
      return true
    }
    const end = start + 86400000
    const sv = raw == null ? "" : String(attrTextIfNeeded(def, raw))
    const ts = sv ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(sv) ? sv + "T00:00:00" : sv) : NaN
    if (!isFinite(ts)) {
      return false
    }
    switch (f.op) {
      case "onafter":
        return ts >= start
      case "onbefore":
        return ts < end
      case "on":
        return ts >= start && ts < end
    }
    return true
  }

  const want = String(f.value).toLowerCase()
  // "contains" searches deep (nested leaves too); eq/neq/begins compare against
  // the human-readable collapsed scalar the cell actually shows.
  if (f.op === "contains") {
    return (raw == null ? "" : attrSearchText(raw)).toLowerCase().includes(want)
  }
  const s = (raw == null ? "" : attrText(raw)).toLowerCase()
  switch (f.op) {
    case "eq":
      return s === want
    case "neq":
      return s !== want
    case "begins":
      return s.startsWith(want)
  }
  return true
}

const sortVal = (def: FieldDef, r: CaseRecord): number | string | null => {
  const raw = def.get(r)
  if (raw == null || raw === "") {
    return null
  }
  if (def.type === "number") {
    return numOf(raw)
  }
  if (def.type === "date") {
    const t = Date.parse(String(attrTextIfNeeded(def, raw)))
    return isFinite(t) ? t : null
  }
  const s = attrText(raw)
  return s === "—" ? null : s.toLowerCase()
}

const stableSort = (records: CaseRecord[], sorts: OvSort[]): CaseRecord[] => {
  const levels = sorts
    .map((s) => ({ def: fieldDef(s.key), dir: s.dir === -1 ? -1 : 1 }))
    .filter((l): l is { def: FieldDef; dir: number } => !!l.def)
  if (!levels.length) {
    return records
  }
  const keyed = records.map((r, i) => ({ r, i, v: levels.map((l) => sortVal(l.def, r)) }))
  keyed.sort((A, B) => {
    for (let li = 0; li < levels.length; li++) {
      const a = A.v[li]
      const b = B.v[li]
      const an = a == null
      const bn = b == null
      if (an || bn) {
        if (an && bn) {
          continue
        }
        return an ? 1 : -1 // nulls last either way
      }
      if (a < b) {
        return -levels[li]!.dir
      }
      if (a > b) {
        return levels[li]!.dir
      }
    }
    return A.i - B.i
  })
  return keyed.map((k) => k.r)
}

export type QueryResult = {
  rows: CaseRecord[]
  total: number
  page: number
  pages: number
  from: number
  to: number
}

// Filter → sort → page. `flow` gets no paging. `total` counts matches BEFORE
// paging. Returns the page snapped into range when a filter shrinks results —
// the caller writes that back (applyQuery itself stays pure).
export const applyQuery = (records: CaseRecord[], tab: OvTab): QueryResult => {
  const o = ov()
  ensureFields(records)
  let out = records

  if (o.prog) {
    out = out.filter((r) => progressCat(r) === o.prog)
  }
  const needle = o.q.trim().toLowerCase()
  if (needle) {
    out = out.filter((r) => haystack(r).includes(needle))
  }
  for (const f of o.filters) {
    out = out.filter((r) => matchFilter(r, f))
  }
  // Activity recency window: keep cases whose chosen business date is at or
  // after the rolling cutoff.
  if (o.activity?.within) {
    const cutoff = windowCutoff(o.activity.within, Date.now())
    const def = SYS_FIELDS[o.activity.field] || SYS_FIELDS.lastAt!
    if (cutoff != null) {
      out = out.filter((r) => {
        const raw = def.get(r)
        const ts = raw ? Date.parse(String(raw)) : NaN
        return isFinite(ts) && ts >= cutoff
      })
    }
  }

  const total = out.length
  out = stableSort(out, o.sort.length ? o.sort : DEFAULT_SORT[tab] || [])

  const t = tab === "list" || tab === "rows" ? o.tab[tab] : null
  if (!t) {
    return { rows: out, total, page: 0, pages: 1, from: total ? 1 : 0, to: total }
  }
  const pages = Math.max(1, Math.ceil(total / t.pageSize))
  const page = Math.min(Math.max(0, t.page), pages - 1)
  const from = page * t.pageSize
  return {
    rows: out.slice(from, from + t.pageSize),
    total,
    page,
    pages,
    from: total ? from + 1 : 0,
    to: Math.min(total, from + t.pageSize),
  }
}

// (The old firings-only flowSlice is gone: the Workflow tab now derives ALL its
// counters — coverage, pace partition, edge stats, anomalies — from cohortStats
// over the applyQuery result, so every overlay recomputes under an active
// filter and the whole view shares one denominator.)

// --- URL hash sync — #list?q=…&f=…&s=…&p=…&pg=…&n= (replaceState: no reload) ---

const esc = (s: unknown) => encodeURIComponent(String(s)).replace(/~/g, "%7E")
const unesc = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// Shared parts always; page/pageSize only when a tab is given (they are per-tab
// and deliberately dropped when hopping tabs via the view switcher).
export const serializeOv = (tab: OvTab | null): string => {
  const o = ov()
  const p = new URLSearchParams()
  if (o.q.trim()) {
    p.set("q", o.q.trim())
  }
  if (o.prog) {
    p.set("p", o.prog)
  }
  if (o.activity?.within) {
    p.set("act", `${o.activity.field}:${o.activity.within}`)
  }
  for (const f of o.filters) {
    if (String(f.value ?? "") === "") {
      continue
    }
    p.append("f", `${esc(f.field)}~${f.op}~${esc(f.value)}`)
  }
  if (o.sort.length) {
    p.set("s", o.sort.map((s) => (s.dir === -1 ? "-" : "") + esc(s.key)).join(","))
  }
  const t = tab === "list" || tab === "rows" ? o.tab[tab] : null
  if (t && tab) {
    if (t.page > 0) {
      p.set("pg", String(t.page))
    }
    if (t.pageSize !== DEFAULT_PAGE_SIZE[tab]) {
      p.set("n", String(t.pageSize))
    }
  }
  return p.toString()
}

export const hydrateOv = (tab: OvTab | null, qs: string) => {
  const o = ov()
  const p = new URLSearchParams(qs || "")
  const prog = p.get("p") || ""
  const act = (p.get("act") || "").split(":")

  const next: Partial<OvState> = {
    q: p.get("q") || "",
    prog: ["none", "active", "done"].includes(prog) ? prog : "",
    activity: {
      field: act[0] === "startedAt" ? "startedAt" : "lastAt",
      within: ACTIVITY_WINDOWS.some(([v]) => v === act[1]) ? act[1]! : "",
    },
    filters: p
      .getAll("f")
      .map((tok) => {
        const m = tok.split("~")
        if (m.length < 3) {
          return null
        }
        return { field: unesc(m[0]!), op: m[1]!, value: unesc(m.slice(2).join("~")) }
      })
      .filter((f): f is OvFilter => !!f),
    sort: (p.get("s") || "")
      .split(",")
      .filter(Boolean)
      .map((tok) => ({ key: unesc(tok.replace(/^-/, "")), dir: (tok.startsWith("-") ? -1 : 1) as 1 | -1 })),
  }

  if (tab === "list" || tab === "rows") {
    const t = o.tab[tab]
    const n = Number(p.get("n"))
    next.tab = {
      ...o.tab,
      [tab]: {
        page: Math.max(0, Math.floor(Number(p.get("pg")) || 0)),
        pageSize: pageSizesFor(tab).includes(n) ? n : t.pageSize,
      },
    }
  }
  patchOv(next)
}

const HASH_BASE: Record<string, string> = { flow: "#flow", rows: "#rows", list: "#list", todo: "#todo" }

export const syncOvHash = (tab: OvTab) => {
  const base = HASH_BASE[tab]
  if (!base) {
    return
  }
  // Never rewrite another tab's hash: a drill-down patches the query state and
  // navigates in one go, and the still-mounted origin view's sync effect must
  // not clobber the destination hash before the hashchange lands. The bare home
  // hash is owned by whichever tab Overview mounted there — normalize it.
  const cur = location.hash
  const atHome = cur === "" || cur === "#" || cur.startsWith("#?")
  if (!atHome && !cur.startsWith(base)) {
    return
  }
  const qs = serializeOv(tab)
  history.replaceState(null, "", location.pathname + location.search + base + (qs ? "?" + qs : ""))
}

// The query suffix the view switcher appends so hopping tabs keeps the slice.
export const ovQuerySuffix = () => {
  const qs = serializeOv(null)
  return qs ? "?" + qs : ""
}

// --- List columns + By-case gutter attributes (column chooser) ---

export const SYS_COL_TOKENS = ["$status", "$createdAt", "$updatedAt", "$lastEvent"]

const SYS_COL_META: Record<string, { label: string; sort: string; attr?: string }> = {
  $status: { label: "status", sort: "status" },
  $createdAt: { label: "created", sort: "createdAt" },
  $updatedAt: { label: "updated", sort: "updatedAt" },
  $lastEvent: { label: "last activity", sort: "lastAt" },
  // Not choosable (pinned by the List's column plan) but still needs metadata.
  $progress: { label: "progress", sort: "progress" },
}

export const defaultColTokens = (records: CaseRecord[]) => [
  ...attrColumns(records).slice(0, 4),
  "$status",
  "$lastEvent",
]

// The ordered, validated column tokens for the List (ID and Progress render
// unconditionally around these — Progress is mandatory by design).
export const listColTokens = (records: CaseRecord[]) => {
  const o = ov()
  const attrs = new Set(attrColumns(records))
  return (o.cols ?? defaultColTokens(records)).filter(
    (t) => t !== "$progress" && (SYS_COL_META[t] ? true : attrs.has(t)),
  )
}

export const colMeta = (tok: string) => {
  if (SYS_COL_META[tok]) {
    return SYS_COL_META[tok]!
  }
  return { label: prettyEntity(tok), sort: "a:" + tok, attr: tok }
}

// First chosen attribute columns drive the By-case gutter labels too (falls back
// to the model's mandatory attributes when the user hasn't customized).
export const chosenGutterAttrs = (): string[] | null => {
  const o = ov()
  if (!o.cols) {
    return null
  }
  const attrs = o.cols.filter((t) => !SYS_COL_META[t])
  return attrs.length ? attrs.slice(0, 3) : null
}

// --- Filter/sort menu metadata ---

export const OPS: Record<string, [string, string][]> = {
  string: [
    ["contains", "contains"],
    ["eq", "is"],
    ["neq", "is not"],
    ["begins", "begins with"],
  ],
  number: [
    ["eq", "="],
    ["neq", "≠"],
    ["gte", "≥"],
    ["lte", "≤"],
    ["gt", ">"],
    ["lt", "<"],
  ],
  date: [
    ["onafter", "on or after"],
    ["onbefore", "on or before"],
    ["on", "on"],
  ],
}

export const opLabel = (type: string, op: string) => (OPS[type] || []).find(([o]) => o === op)?.[1] || op
export const defaultOp = (type: string) => (type === "number" ? "gte" : type === "date" ? "onafter" : "contains")

// Sortable fields offered in the Sort menu (system first, then attributes).
export const sortMenuFields = () => {
  const sys = ["progress", "steps", "furthestStep", "readySteps", "nextStep", "nextRole", "lastAt", "startedAt", "createdAt", "updatedAt", "status", "firings", "id"]
  return [...sys, ...attrKeys.map((k) => "a:" + k)]
}

// Filterable fields for the field <select>, grouped.
export const filterFieldGroups = (): [string, string[]][] => [
  ["Progress & status", ["progress", "steps", "total", "furthestStep", "readySteps", "firings", "status"]],
  ["Steps (firing count)", (useStore.getState().events || []).map((e) => stepFieldKey(e.ref))],
  ["Conformance", ["skippedSteps", "multiFiredSteps", "uncorrelated"]],
  ["Timestamps", ["createdAt", "updatedAt", "startedAt", "lastAt"]],
  ["Identity & activity", ["id", "cycle", "lastEvent", "nextStep", "nextRole"]],
  ["Attributes", attrKeys.map((k) => "a:" + k)],
]

// Default sort direction on first activation: newest/biggest first for dates and
// numbers, A→Z for text.
const naturalDir = (key: string): 1 | -1 => {
  const def = fieldDef(key)
  return def && (def.type === "date" || def.type === "number") ? -1 : 1
}

// Click = sort by this key (flipping on the second click, removing on the
// third). `stack` adds it as an extra level instead of replacing.
export const cycleSort = (key: string, stack: boolean) => {
  const sort = ov().sort.map((s) => ({ ...s }))
  const idx = sort.findIndex((s) => s.key === key)
  if (idx === -1) {
    const next = stack ? sort : []
    next.push({ key, dir: naturalDir(key) })
    patchOv({ sort: next })
    return
  }
  if (sort[idx]!.dir === naturalDir(key)) {
    // A non-stacking click on a stacked level promotes it to the only level.
    if (!stack && sort.length > 1) {
      patchOv({ sort: [{ key, dir: naturalDir(key) }] })
      return
    }
    sort[idx]!.dir = (sort[idx]!.dir === -1 ? 1 : -1) as 1 | -1
    patchOv({ sort })
    return
  }
  sort.splice(idx, 1)
  patchOv({ sort })
}

export const flipSort = (key: string) => {
  patchOv({ sort: ov().sort.map((s) => (s.key === key ? { ...s, dir: (s.dir === -1 ? 1 : -1) as 1 | -1 } : s)) })
}

export const removeSort = (key: string) => {
  patchOv({ sort: ov().sort.filter((s) => s.key !== key) })
}

// Reset everything narrowing/ordering the view — but not column choices or
// page-size prefs, which are display preferences rather than a query.
export const resetOvQuery = () => {
  patchOv({ q: "", prog: "", filters: [], sort: [], activity: { field: "lastAt", within: "" } })
}

export const pageAction = (tab: "list" | "rows", act: string) => {
  const t = ov().tab[tab]
  if (act === "first") {
    setOvPage(tab, 0)
  } else if (act === "prev") {
    setOvPage(tab, Math.max(0, t.page - 1))
  } else if (act === "next") {
    setOvPage(tab, t.page + 1) // applyQuery snaps overflow back
  } else if (act === "last") {
    setOvPage(tab, Number.MAX_SAFE_INTEGER) // snapped to the real last page
  }
}

// Toggling a column keeps a stable order: attributes in model order, then system.
export const toggleOvCol = (records: CaseRecord[], tok: string, on: boolean) => {
  const cur = listColTokens(records)
  const next = on ? [...cur, tok] : cur.filter((t) => t !== tok)
  const order = [...attrColumns(records), ...SYS_COL_TOKENS]
  setOvCols(order.filter((t) => next.includes(t)))
}

// Compact absolute stamp for Created/Updated cells.
export const fmtStamp = (iso?: string | null) => {
  if (!iso) {
    return "—"
  }
  const d = new Date(iso)
  if (isNaN(d.getTime())) {
    return "—"
  }
  return d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export type { Row, EventDef }
