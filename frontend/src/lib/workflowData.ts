import { api } from "./api.ts"
import { useStore } from "./store.ts"
import { loadRecs } from "./todoData.ts"
import type { CaseRow, EventDef, FlowAggregate, FlowRows, Meta, NextActionsResult } from "./types.ts"

export const loadRegistryStatus = async () => {
  try {
    const s = await api<{ ok: boolean; error?: string }>("/sim/registry-status")
    useStore.getState().set({ registryError: s.ok ? null : s.error || null })
  } catch {
    // Leave the banner state as-is — a failure here shouldn't blank it.
  }
}

export const loadMeta = async () => {
  try {
    const meta = await api<Meta>("/sim/meta")
    useStore.getState().set({ meta })
    document.title = `${meta.title} — Live`
  } catch {
    // Keep the defaults.
  }
}

// The full case/flow-row payloads are large (megabytes at thousands of cases),
// so the 5s live poll must NOT re-download them every tick. Each full load
// records a cheap change-stamp from the flow aggregate; the poll re-fetches that
// stamp only and re-downloads the heavy payloads solely when it moves. An
// hourly bucket is folded in because dwell/staleness (the To do tab's primary
// signal) advance with the CLOCK, not with new events — without it a quiet
// workflow's tab would freeze its server-computed dwellDays forever.
let ovStamp: string | null = null
const stampOf = (flow: FlowAggregate | null) =>
  flow ? `${flow.totalCases}:${flow.totalFirings}:${Math.floor(Date.now() / 3_600_000)}` : ""

// Every Overview tab loads the SAME full dataset (?limit=0 lifts the server
// caps). The shared query engine filters/sorts/pages client-side, so a search on
// one tab carries to the others and only the current page is ever rendered.
// next-actions rides every full load: the To do tab, the Flow "top things to do"
// panel and the List's next-step columns all read it from any tab.
export const loadDashboard = async () => {
  const [cases, events, flowRows, flow, nextActions] = await Promise.all([
    api<CaseRow[]>("/sim/cases?limit=0"),
    api<EventDef[]>("/sim/events"),
    api<FlowRows>("/sim/flow-by-case?limit=0"),
    api<FlowAggregate>("/sim/flow-aggregate"),
    api<NextActionsResult>("/sim/next-actions?limit=0"),
    loadRegistryStatus(),
    loadMeta(),
    loadRecs(), // freshness is server-computed — keep it current on every tab
  ])
  ovStamp = stampOf(flow)
  useStore.getState().set({ cases, events, flowRows, flow, nextActions, dashLoaded: true })
}

export const loadFlow = async () => {
  const [flow, events, flowRows, cases, nextActions] = await Promise.all([
    api<FlowAggregate>("/sim/flow-aggregate"),
    api<EventDef[]>("/sim/events"),
    api<FlowRows>("/sim/flow-by-case?limit=0"),
    api<CaseRow[]>("/sim/cases?limit=0"),
    api<NextActionsResult>("/sim/next-actions?limit=0"),
    loadRegistryStatus(),
    loadMeta(),
    loadRecs(),
  ])
  ovStamp = stampOf(flow)
  useStore.getState().set({ flow, events, flowRows, cases, nextActions, dashLoaded: true })
}

// Per-case flow (#rows). The old server-side 50-row cap is gone — pagination
// bounds what actually renders.
export const loadFlowRows = async () => {
  const [flowRows, events, cases, flow, nextActions] = await Promise.all([
    api<FlowRows>("/sim/flow-by-case?limit=0"),
    api<EventDef[]>("/sim/events"),
    api<CaseRow[]>("/sim/cases?limit=0"),
    api<FlowAggregate>("/sim/flow-aggregate"),
    api<NextActionsResult>("/sim/next-actions?limit=0"),
    loadRegistryStatus(),
    loadMeta(),
    loadRecs(),
  ])
  ovStamp = stampOf(flow)
  useStore.getState().set({ flowRows, events, cases, flow, nextActions, dashLoaded: true })
}

// The To do tab (#todo) reads the same dataset — the frontier is the star but
// the shared query engine still needs cases/flowRows to apply cross-tab filters.
// The stored AI ranking (+ freshness) rides along; it never triggers generation.
export const loadTodo = async () => {
  const [nextActions, events, cases, flowRows, flow] = await Promise.all([
    api<NextActionsResult>("/sim/next-actions?limit=0"),
    api<EventDef[]>("/sim/events"),
    api<CaseRow[]>("/sim/cases?limit=0"),
    api<FlowRows>("/sim/flow-by-case?limit=0"),
    api<FlowAggregate>("/sim/flow-aggregate"),
    loadRegistryStatus(),
    loadMeta(),
    loadRecs(),
  ])
  ovStamp = stampOf(flow)
  useStore.getState().set({ nextActions, events, cases, flowRows, flow, dashLoaded: true })
}

// The 5s live-poll body for every Overview tab. Fetches ONLY the tiny flow
// aggregate; when nothing changed it leaves the heavy endpoints alone.
export const pollOverview = async (view: string) => {
  if (useStore.getState().busy) {
    return
  }
  let flow: FlowAggregate
  try {
    flow = await api<FlowAggregate>("/sim/flow-aggregate")
  } catch {
    return
  }
  useStore.getState().set({ flow }) // keep #flow counters live even on a no-change tick
  const stamp = stampOf(flow)
  if (stamp === ovStamp) {
    return
  }
  ovStamp = stamp
  if (view === "flow") {
    await loadFlow()
  } else if (view === "rows") {
    await loadFlowRows()
  } else if (view === "todo") {
    await loadTodo()
  } else {
    await loadDashboard()
  }
}
