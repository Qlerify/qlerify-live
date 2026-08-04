import { api } from "./api.ts"
import { useStore } from "./store.ts"
import { loadMeta, loadRegistryStatus } from "./workflowData.ts"
import { bizTimeEstimated } from "./time.ts"
import type { EventDef, Instance, LogEntry } from "./types.ts"

export const loadDetail = async (caseId: string) => {
  await loadMeta()
  const [instance, events, cur] = await Promise.all([
    api<Instance>("/sim/instance/" + encodeURIComponent(caseId)),
    api<EventDef[]>("/sim/events"),
    api<{ index: number }>("/sim/current-step?caseId=" + encodeURIComponent(caseId)),
    loadRegistryStatus(),
  ])

  const s = useStore.getState()
  // Only diff within the same run — switching runs starts clean, and collapses
  // any expanded firings / active split.
  const sameRun = s.instance && s.instance.instanceId === instance.instanceId
  const prevInstance = sameRun ? s.instance : null

  s.set({
    prevInstance,
    instance,
    events,
    // newest-first, so "last event" reads the latest first
    log: (instance.events || []).slice().reverse(),
    currentIndex: cur.index,
    ...(prevInstance ? {} : { expandedFirings: new Set<string>(), splitRef: null, selectedStep: null }),
  })
}

export const doNext = async (caseId: string) => {
  const s = useStore.getState()
  if (s.busy) {
    return
  }
  // Advancing the live run drops any as-of scrub.
  s.set({ busy: true, selectedStep: null })
  try {
    await api("/sim/next", { method: "POST", body: JSON.stringify({ caseId }) })
    await loadDetail(caseId)
  } catch (e) {
    alert((e as Error).message)
  } finally {
    useStore.getState().set({ busy: false })
  }
}

export const doRunAll = async (caseId: string) => {
  const s = useStore.getState()
  if (s.busy) {
    return
  }
  s.set({ busy: true, selectedStep: null })
  try {
    await api("/sim/run-all", { method: "POST", body: JSON.stringify({ caseId }) })
    await loadDetail(caseId)
  } catch (e) {
    alert((e as Error).message)
  } finally {
    useStore.getState().set({ busy: false })
  }
}

export const doReset = async (caseId: string, onDone: () => void) => {
  const s = useStore.getState()
  if (s.busy) {
    return
  }
  if (!confirm("Reset this case and start over?")) {
    return
  }
  s.set({ busy: true })
  try {
    await api("/sim/reset", { method: "POST", body: JSON.stringify({ caseId }) })
    onDone()
  } finally {
    useStore.getState().set({ busy: false })
  }
}

// The event refs that actually fired for this instance. A derived run fires a
// non-contiguous subset, so step state must come from the log, not a cursor.
export const firedRefSet = (log: LogEntry[]) => new Set(log.map((e) => e.eventRef))

export const firedCountMap = (log: LogEntry[]) => {
  const counts = new Map<string, number>()
  for (const entry of log) {
    counts.set(entry.eventRef, (counts.get(entry.eventRef) || 0) + 1)
  }
  return counts
}

// All firings per ref, oldest → newest. `log` is newest-first, so unshifting
// while iterating yields chronological order.
export const firingsByRefMap = (log: LogEntry[]) => {
  const m = new Map<string, LogEntry[]>()
  for (const entry of log) {
    if (!m.has(entry.eventRef)) {
      m.set(entry.eventRef, [])
    }
    m.get(entry.eventRef)!.unshift(entry)
  }
  return m
}

// eventRef → the businessAt recorded when the step fired, plus whether that time
// is estimated rather than witnessed.
export const businessByStep = (log: LogEntry[]) => {
  const m = new Map<string, { iso: string; est: boolean }>()
  for (const entry of log) {
    if (entry.businessAt && !m.has(entry.eventRef)) {
      m.set(entry.eventRef, { iso: entry.businessAt, est: bizTimeEstimated(entry) })
    }
  }
  return m
}

export const FIRING_ROW_H = 16

// A header band plus a slim row per firing; +26 leaves room for the split button.
export const expandedCardHeight = (n: number) => 84 + n * FIRING_ROW_H + 26
