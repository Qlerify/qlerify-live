import { showOverlay, hideOverlay } from "@/components/Overlay.tsx"
import { api } from "./api.ts"
import { formatDuration } from "./format.ts"
import { useStore } from "./store.ts"
import type { ExpAdapter, ExpHealth, ExpRowEvent, ExpState, ExpTable, Row } from "./types.ts"

const exp = () => useStore.getState().exp
const patch = (p: Partial<ExpState>) => useStore.getState().set({ exp: { ...useStore.getState().exp, ...p } })

// Per-table connection status for every system — the dot on each Tables row.
export const loadHealth = async () => {
  try {
    patch({ health: await api<ExpHealth>("/api/bc/health") })
  } catch {
    patch({ health: { gaps: 0, systems: [] } })
  }
}

const fetchRowEvents = async (system: string, entity: string): Promise<Record<string, ExpRowEvent[]>> => {
  try {
    const d = await api<{ byRow?: Record<string, ExpRowEvent[]> }>(
      `/api/bc/${encodeURIComponent(system)}/row-events?entity=${encodeURIComponent(entity)}&limit=2000`,
    )
    return d.byRow || {}
  } catch {
    return {}
  }
}

// Rows come one pager window at a time: EXP_PAGE rows for the current page, plus
// `matched` (rows passing the filters — sizes the pager) and `total` (the whole
// table — the "of N"). Filtering/paging happen in SQL, so every row is reachable.
export const EXP_PAGE = 25

type RawPage = { rows?: Row[]; matched?: number; total?: number; tableMissing?: boolean }

const fetchExpRows = async (): Promise<void> => {
  const e = exp()
  if (!e.system || !e.entity) {
    return
  }
  const filters = (e.filters || []).filter((f) => f.attr && f.value !== "")
  const qs = new URLSearchParams({
    entity: e.entity,
    limit: String(EXP_PAGE),
    offset: String(e.page * EXP_PAGE),
  })
  if (filters.length) {
    qs.set("filters", JSON.stringify(filters))
  }
  const d = await api<RawPage>(`/api/bc/${encodeURIComponent(e.system)}/raw?${qs}`)
  const items = d.rows || []
  const matched = d.matched ?? items.length
  patch({ items, matched, total: d.total ?? matched, tableMissing: !!d.tableMissing })

  // Filtering/deleting can strand the page past the end — snap to the last page.
  if (e.page > 0 && !items.length && matched > 0) {
    patch({ page: Math.max(0, Math.ceil(matched / EXP_PAGE) - 1) })
    return fetchExpRows()
  }
}

// Page/filter change on the current table: re-pull the window. Lighter than
// selectEntity — no overlay, and the row-events map (keyed by row id, fetched
// table-wide) stays valid.
export const refetchExpRows = async () => {
  const e = exp()
  if (!e.system || !e.entity) {
    return
  }
  patch({ busy: true })
  try {
    await fetchExpRows()
  } catch {
    // keep prior rows
  } finally {
    patch({ busy: false })
  }
}

export const setExpPage = (page: number) => {
  patch({ page })
  refetchExpRows()
}

export const runExpFilters = () => {
  patch({ page: 0 })
  refetchExpRows()
}

export const resetExpFilters = () => {
  patch({ filters: [], page: 0 })
  refetchExpRows()
}

export const selectEntity = async (name: string) => {
  const e = exp()
  const system = e.system
  if (!system) {
    return
  }
  patch({ entity: name, page: 0, filters: [], busy: true, rowEvents: {} })
  showOverlay("Loading data…")
  try {
    try {
      await fetchExpRows()
    } catch {
      patch({ items: [], matched: 0, total: 0, tableMissing: true })
    }
    patch({ rowEvents: await fetchRowEvents(system, name) })
  } finally {
    patch({ busy: false })
    hideOverlay()
  }
}

export const selectSystem = async (name: string, targetEntity?: string | null) => {
  patch({ system: name, entity: null, items: [], matched: 0, total: 0, filters: [], page: 0 })
  try {
    const d = await api<{
      entities?: ExpTable[]
      valueObjects?: ExpTable[]
      adapters?: ExpAdapter[]
      defaultEntity?: string
    }>(`/api/bc/${encodeURIComponent(name)}`)
    patch({ entities: d.entities || [], valueObjects: d.valueObjects || [], adapters: d.adapters || [] })
    const def =
      targetEntity || d.defaultEntity || (d.entities || [])[0]?.name || (d.valueObjects || [])[0]?.name
    if (def) {
      await selectEntity(def)
    }
  } catch {
    patch({ entities: [], valueObjects: [], adapters: [] })
  }
}

export const loadExplorer = async (deepSystem?: string | null, deepEntity?: string | null) => {
  let systems: { name: string }[] = []
  try {
    systems = await api<{ name: string }[]>("/api/bc")
  } catch {
    systems = []
  }
  patch({ systems })
  loadHealth()

  const e = exp()
  const wanted = deepSystem || (e.system && systems.some((s) => s.name === e.system) ? e.system : null)
  const first = systems[0]?.name
  const target = wanted || first
  if (target) {
    await selectSystem(target, deepEntity)
  }
}

// After an ingest/clear (or a connector-builder turn), re-pull the system's
// adapters, the selected table's rows, and the derived per-row events.
export const refreshExplorer = async () => {
  const e = exp()
  if (!e.system) {
    return
  }
  try {
    const d = await api<{ entities?: ExpTable[]; valueObjects?: ExpTable[]; adapters?: ExpAdapter[] }>(
      `/api/bc/${encodeURIComponent(e.system)}`,
    )
    patch({
      adapters: d.adapters || [],
      entities: d.entities || e.entities,
      valueObjects: d.valueObjects || e.valueObjects,
    })
  } catch {
    // keep prior
  }
  const cur = exp()
  if (cur.entity) {
    try {
      await fetchExpRows()
    } catch {
      // keep prior
    }
    patch({ rowEvents: await fetchRowEvents(cur.system!, cur.entity) })
  }
  await loadHealth()
}

export const adaptersForEntity = (e: ExpState) => (e.adapters || []).filter((a) => a.targetEntity === e.entity)

export const fetchRows = async () => {
  const e = exp()
  if (e.busy || !e.entity) {
    return
  }
  const adapters = adaptersForEntity(e)
  if (!adapters.length) {
    alert("No connector configured for this table. Use the “Configure connector” button to build one first.")
    return
  }
  const adapter = adapters[0]!
  if (
    !confirm(
      `Fetch rows from the data source via connector "${adapter.id}"?\n\nNew rows are inserted; changed rows are updated in place; unchanged rows are skipped.`,
    )
  ) {
    return
  }
  patch({ busy: true })
  showOverlay("Refreshing data…")
  try {
    const r = await api<{
      inserted: number
      skipped: number
      updated?: number
      durationMs?: number
      fetchMs?: number
      derived?: { events: number; instances: number; durationMs?: number }
    }>(
      `/api/adapters/${encodeURIComponent(adapter.id)}/pull`,
      { method: "POST", body: JSON.stringify({ limit: null }) }, // null = uncapped: pull ALL rows from the source
    )
    await refreshExplorer()
    hideOverlay()
    const derivedTook = r.derived?.durationMs != null ? `, ${formatDuration(r.derived.durationMs)}` : ""
    const ev = r.derived?.events
      ? `\nEvents derived: ${r.derived.events} (${r.derived.instances} instance(s)${derivedTook})`
      : ""
    const took =
      r.durationMs != null
        ? `\nTook: ${formatDuration(r.durationMs)}${r.fetchMs != null ? ` (fetch ${formatDuration(r.fetchMs)})` : ""}`
        : ""
    alert(`Fetched from source.\n\nInserted: ${r.inserted}\nUpdated: ${r.updated ?? 0}\nUnchanged: ${r.skipped}${ev}${took}`)
  } catch (err) {
    hideOverlay()
    alert("Fetch failed: " + (err as Error).message)
  } finally {
    patch({ busy: false })
  }
}

export const clearRows = async () => {
  const e = exp()
  if (e.busy || !e.entity || !e.system) {
    return
  }
  if (
    !confirm(
      `Delete ALL rows in table "${e.entity}"?\n\nThis clears the ingested data for this table AND the simulated events derived from it. Connectors are kept.`,
    )
  ) {
    return
  }
  patch({ busy: true })
  showOverlay("Deleting rows…")
  try {
    const r = await api<{ deleted: number; eventsDeleted?: number }>(
      `/api/bc/${encodeURIComponent(e.system)}/clear`,
      { method: "POST", body: JSON.stringify({ entity: e.entity }) },
    )
    await refreshExplorer()
    hideOverlay()
    const evt = r.eventsDeleted ? ` and ${r.eventsDeleted} derived event(s)` : ""
    alert(r.deleted ? `Deleted ${r.deleted} row(s)${evt} from ${e.entity}.` : `No rows to delete in ${e.entity}.`)
  } catch (err) {
    hideOverlay()
    alert("Delete failed: " + (err as Error).message)
  } finally {
    patch({ busy: false })
  }
}

export const reimportAll = async () => {
  const e = exp()
  if (e.busy) {
    return
  }
  if (
    !confirm(
      "Empty ALL base-data tables and the entire event log, then reimport the base data from every configured connector?\n\nThis clears every ingested row and derived event across all systems, then re-pulls each connector from its source. Connectors and the model are kept.",
    )
  ) {
    return
  }
  patch({ busy: true })
  showOverlay("Resetting & reimporting…")
  try {
    const r = await api<{
      connectors: number
      inserted: number
      derived?: { events: number; instances: number }
      failures?: { id: string }[]
      durationMs?: number
      // no limit = uncapped: a full restore re-pulls everything
    }>("/api/data/reimport-all", { method: "POST", body: "{}" })
    await refreshExplorer()
    hideOverlay()
    const ev = r.derived ? `\nEvents derived: ${r.derived.events} (${r.derived.instances} instance(s))` : ""
    const failed = r.failures?.length
      ? `\nConnectors that failed: ${r.failures.length} (${r.failures.map((f) => f.id).join(", ")})`
      : ""
    const took = r.durationMs != null ? `\nTook: ${formatDuration(r.durationMs)}` : ""
    alert(
      `Reset & reimport complete.\n\nConnectors pulled: ${r.connectors}\nRows inserted: ${r.inserted}${ev}${failed}${took}`,
    )
  } catch (err) {
    hideOverlay()
    alert("Reset & reimport failed: " + (err as Error).message)
  } finally {
    patch({ busy: false })
  }
}

export const kindOf = (e: ExpState, name: string | null) => {
  if (!name) {
    return null
  }
  if ((e.entities || []).some((t) => t.name === name)) {
    return "entity"
  }
  if ((e.valueObjects || []).some((t) => t.name === name)) {
    return "valueObject"
  }
  return null
}

// Pure infrastructure columns — never rendered. Everything else, including
// id/version/createdAt, is ordinary data judged against the model.
export const EXP_HIDDEN_COLS = new Set(["_provenance", "organization_id"])

export type ColState = "green" | "ghost" | "amber" | "neutral"

// green – in the model AND populated; ghost – modelled but never filled;
// amber – in the data but not the model (drift or simply unmodelled).
export const expColumns = (items: Row[], entity?: ExpTable): { name: string; state: ColState }[] => {
  const modelFields = entity?.fields ? entity.fields.map((f) => f.name) : []
  const modelSet = new Set(modelFields)
  const hasModel = modelSet.size > 0

  const dataKeys = new Set<string>()
  for (const r of items || []) {
    for (const k of Object.keys(r)) {
      if (EXP_HIDDEN_COLS.has(k)) {
        continue
      }
      const v = r[k]
      if (v !== null && v !== undefined && v !== "") {
        dataKeys.add(k)
      }
    }
  }

  const stateOf = (name: string): ColState => {
    if (!hasModel) {
      return "neutral"
    }
    if (modelSet.has(name)) {
      return dataKeys.has(name) ? "green" : "ghost"
    }
    return "amber"
  }

  const out: { name: string; state: ColState }[] = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name)
      out.push({ name, state: stateOf(name) })
    }
  }

  if (dataKeys.has("id") || modelSet.has("id")) {
    push("id")
  }
  for (const f of modelFields) {
    push(f)
  }
  for (const k of dataKeys) {
    if (!modelSet.has(k)) {
      push(k)
    }
  }
  return out.length ? out : [{ name: "id", state: "neutral" }]
}
