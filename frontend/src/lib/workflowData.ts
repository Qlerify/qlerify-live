import { api } from "./api.ts"
import { useStore } from "./store.ts"
import type { CaseRow, EventDef, Meta } from "./types.ts"

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

export const loadDashboard = async () => {
  const [cases, events] = await Promise.all([
    api<CaseRow[]>("/sim/cases"),
    api<EventDef[]>("/sim/events"),
    loadRegistryStatus(),
    loadMeta(),
  ])
  useStore.getState().set({ cases, events })
}
