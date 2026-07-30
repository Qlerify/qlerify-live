import { api } from "./api.ts"
import { useStore } from "./store.ts"
import type { Connector, ConnectorsData, TestResult, VerifyResult } from "./types.ts"

// Colour chip per update-note kind (connector doc timeline).
export const NOTE_BADGE: Record<string, string> = {
  created: "bg-sky-100 text-sky-800",
  built: "bg-emerald-100 text-emerald-800",
  edited: "bg-lime-100 text-lime-800",
  repaired: "bg-amber-100 text-amber-800",
  credentials: "bg-violet-100 text-violet-800",
  ingested: "bg-teal-100 text-teal-800",
  cleared: "bg-orange-100 text-orange-800",
  repointed: "bg-indigo-100 text-indigo-800",
  removed: "bg-rose-100 text-rose-800",
  note: "bg-stone-100 text-stone-700",
}

// kebab-slug, byte-for-byte the backend's connector-id minting.
export const connectorSlug = (s?: string) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "connector"

// The id is an immutable persistence key minted once from system+table; a
// re-point freezes it, so rendering the raw id would read as a stale "wrong
// table" name. Derive the display name from the CURRENT target — but only for
// auto-minted ids (which carry the system slug as a prefix); a custom id is the
// user's chosen name and is left alone.
export const connectorName = (c: { id?: string; boundedContext?: string; targetEntity?: string }, bcFallback?: string) => {
  const bc = c.boundedContext || bcFallback || ""
  const id = c.id || ""
  return id.startsWith(connectorSlug(bc) + "-") ? connectorSlug(`${bc}-${c.targetEntity}`) : id
}

export const loadConnectors = async () => {
  const set = useStore.getState().set
  set({ connBusy: true })
  try {
    const d = await api<ConnectorsData>("/api/connectors")
    const ids = (d.connectors || []).map((c) => c.id)
    const cur = useStore.getState().connSel
    set({
      connectors: d,
      connError: null,
      connSel: cur && ids.includes(cur) ? cur : ids[0] || null,
    })
  } catch (e) {
    set({ connectors: { connectors: [], tables: [] }, connError: (e as Error).message })
  } finally {
    set({ connBusy: false })
  }
}

const currentConn = (): Connector | null => {
  const s = useStore.getState()
  return (s.connectors?.connectors || []).find((c) => c.id === s.connSel) || null
}

export const connVerify = async () => {
  const c = currentConn()
  const s = useStore.getState()
  if (!c || s.connBusy) {
    return
  }
  s.set({ connBusy: true })
  try {
    const r = await api<Omit<VerifyResult, "id">>(
      `/api/bc/${encodeURIComponent(c.boundedContext)}/adapter/${encodeURIComponent(c.id)}/verify`,
      { method: "POST", body: "{}" },
    )
    useStore.getState().set({ connVerify: { id: c.id, ...r } })
  } catch (e) {
    useStore.getState().set({ connVerify: { id: c.id, ok: false, detail: (e as Error).message } })
  } finally {
    useStore.getState().set({ connBusy: false })
  }
}

// A DRY-RUN pull (limit 5) graded against the model. Nothing is written.
export const connTest = async () => {
  const c = currentConn()
  const s = useStore.getState()
  if (!c || s.connBusy) {
    return
  }
  s.set({ connBusy: true })
  try {
    const r = await api<Omit<TestResult, "id">>(
      `/api/bc/${encodeURIComponent(c.boundedContext)}/adapter/${encodeURIComponent(c.id)}/test`,
      { method: "POST", body: JSON.stringify({ limit: 5 }) },
    )
    useStore.getState().set({ connTest: { id: c.id, ...r } })
  } catch (e) {
    useStore.getState().set({ connTest: { id: c.id, error: (e as Error).message } })
  } finally {
    useStore.getState().set({ connBusy: false })
  }
}

export const connSaveDateRoles = async (created: string | null, updated: string | null) => {
  const s = useStore.getState()
  const id = s.connSel
  if (!id || s.connBusy) {
    return
  }
  s.set({ connBusy: true })
  try {
    await api(`/api/connectors/${encodeURIComponent(id)}/date-roles`, {
      method: "POST",
      body: JSON.stringify({ created, updated }),
    })
    await loadConnectors()
  } catch (e) {
    alert("Couldn't save timestamps: " + (e as Error).message)
  } finally {
    useStore.getState().set({ connBusy: false })
  }
}

export const connRepoint = async (target: string) => {
  const s = useStore.getState()
  const id = s.connSel
  if (!id || s.connBusy) {
    return
  }
  const cur = (s.connectors?.connectors || []).find((c) => c.id === id)
  const name = cur ? connectorName(cur) : id
  if (!target || (cur && target === cur.targetEntity)) {
    alert("Pick a different table to re-point to.")
    return
  }
  if (
    !confirm(
      `Re-point connector "${name}" to table "${target}"?\n\nIt will fill "${target}" on the next Fetch. Existing rows in "${cur?.targetEntity}" are left untouched.`,
    )
  ) {
    return
  }
  s.set({ connBusy: true })
  try {
    await api(`/api/connectors/${encodeURIComponent(id)}/repoint`, {
      method: "POST",
      body: JSON.stringify({ target }),
    })
    await loadConnectors()
    alert(`Re-pointed to "${target}".`)
  } catch (e) {
    alert("Re-point failed: " + (e as Error).message)
  } finally {
    useStore.getState().set({ connBusy: false })
  }
}

export const connDelete = async () => {
  const s = useStore.getState()
  const id = s.connSel
  if (!id || s.connBusy) {
    return
  }
  const cur = (s.connectors?.connectors || []).find((c) => c.id === id)
  const name = cur ? connectorName(cur) : id
  if (
    !confirm(
      `Completely delete connector "${name}"?\n\nThis permanently deletes its code, credentials, ALL ingested rows in "${cur?.targetEntity}", the derived events, and its entire history. The connector is removed. This cannot be undone.`,
    )
  ) {
    return
  }
  s.set({ connBusy: true })
  try {
    const r = await api<{ deletedRows: number; deletedEvents: number }>(
      `/api/connectors/${encodeURIComponent(id)}/delete`,
      { method: "POST", body: "{}" },
    )
    useStore.getState().set({ connSel: null })
    await loadConnectors()
    alert(`Connector "${name}" deleted.\n\nRemoved ${r.deletedRows} row(s) and ${r.deletedEvents} event(s).`)
  } catch (e) {
    alert("Delete failed: " + (e as Error).message)
  } finally {
    useStore.getState().set({ connBusy: false })
  }
}

export const fetchConnectorCode = (id: string) => api<{ code?: string }>(`/api/connectors/${encodeURIComponent(id)}/code`)

export const saveConnectorCode = (id: string, code: string) =>
  api<{ bytes: number; deps?: string[]; install?: { ok: boolean; log?: string } }>(
    `/api/connectors/${encodeURIComponent(id)}/code`,
    { method: "POST", body: JSON.stringify({ code }) },
  )
