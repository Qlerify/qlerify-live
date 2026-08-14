import { showOverlay, hideOverlay } from "@/components/Overlay.tsx"
import { api, apiDownload } from "./api.ts"
import { useStore } from "./store.ts"
import type { Connector, ConnectorManifest, ConnectorsData, TestResult, VerifyResult } from "./types.ts"

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
  rule: "bg-fuchsia-100 text-fuchsia-800",
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
  const ruleNote = (cur?.triggerRules || []).length
    ? ` Its ${cur!.triggerRules!.length} trigger rule(s) die with it — a later "Rebuild from data" re-derives this table's events with the generic heuristics (the model's Given/When/Thens are untouched).`
    : ""
  if (
    !confirm(
      `Completely delete connector "${name}"?\n\nThis permanently deletes its code, credentials, ALL ingested rows in "${cur?.targetEntity}", the derived events, and its entire history.${ruleNote} The connector is removed. This cannot be undone.`,
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

// Download a portable JSON backup (config + code + credential FIELD NAMES —
// never secret values). Non-destructive, so no confirm.
export const connExport = async () => {
  const s = useStore.getState()
  const id = s.connSel
  if (!id || s.connBusy) {
    return
  }
  s.set({ connBusy: true })
  try {
    await apiDownload(`/api/connectors/${encodeURIComponent(id)}/export`, `qlerify-connector-${id}.json`)
  } catch (e) {
    alert("Export failed: " + (e as Error).message)
  } finally {
    useStore.getState().set({ connBusy: false })
  }
}

export const connExportAll = async () => {
  const s = useStore.getState()
  if (s.connBusy) {
    return
  }
  s.set({ connBusy: true })
  try {
    await apiDownload("/api/connectors/export", "qlerify-connectors.json")
  } catch (e) {
    alert("Export failed: " + (e as Error).message)
  } finally {
    useStore.getState().set({ connBusy: false })
  }
}

type ImportResult = {
  imported: { id: string; originalId?: string; credentialKeys?: string[]; install?: { ok: boolean } }[]
  skipped: { id: string; message: string }[]
}

// Restore connectors from an exported envelope. The server decides per entry
// (imported / skipped with a reason) and NEVER overwrites — feeding it a backup
// twice is safe. Secrets aren't in the file; the summary says which connectors
// need credentials re-entered.
export const connImportFile = async (file: File) => {
  if (useStore.getState().connBusy) {
    return
  }
  // Busy BEFORE the first await (file.text() can stall on a cloud-placeholder
  // file) — the same mutual exclusion every other handler here uses.
  useStore.getState().set({ connBusy: true })
  // Blocking overlay: the import is server-synchronous and npm-installs each
  // connector's dependencies, so it can run for minutes with no other signal.
  showOverlay("Importing connectors…")
  try {
    let text: string
    try {
      text = await file.text()
      JSON.parse(text) // fail fast on a non-JSON pick, before any request
    } catch {
      hideOverlay()
      alert(`"${file.name}" is not a valid JSON file.`)
      return
    }
    const r = await api<ImportResult>("/api/connectors/import", { method: "POST", body: text })
    await loadConnectors()
    // Land on the first imported connector — the selection + detail-pane switch
    // keeps the import visible after the summary dialog is dismissed.
    if (r.imported.length) {
      useStore.getState().set({ connSel: r.imported[0].id })
    }
    hideOverlay()

    const okLine = r.imported.length
      ? `Imported ${r.imported.length} connector(s): ${r.imported.map((c) => c.id + (c.originalId ? ` (renamed from ${c.originalId})` : "")).join(", ")}.`
      : "Nothing imported."
    const skipLine = r.skipped.length
      ? `\n\nSkipped ${r.skipped.length}:\n${r.skipped.map((s) => `• ${s.id} — ${s.message}`).join("\n")}`
      : ""
    const badInstall = r.imported.filter((c) => c.install && c.install.ok === false)
    const installLine = badInstall.length
      ? `\n\n⚠ Package install failed for: ${badInstall.map((c) => c.id).join(", ")} — open the connector's Code tab and Save to retry, or Test to see the error.`
      : ""
    const needCreds = r.imported.filter((c) => (c.credentialKeys || []).length)
    const credLine = needCreds.length
      ? `\n\n⚠ Secrets are never included in a backup. Re-enter credentials for: ${needCreds.map((c) => `${c.id} (${c.credentialKeys!.join(", ")})`).join("; ")} — ask the chat to set them.`
      : ""
    alert(okLine + skipLine + installLine + credLine)
  } catch (e) {
    hideOverlay()
    alert("Import failed: " + (e as Error).message)
  } finally {
    useStore.getState().set({ connBusy: false })
  }
}

// Enable/disable unattended polling. The server floors the interval and clears
// the failure streak, so re-enabling after a fix is one action.
export const connSaveSchedule = async (enabled: boolean, everyMinutes: number) => {
  const s = useStore.getState()
  const id = s.connSel
  if (!id || s.connBusy) {
    return
  }
  s.set({ connBusy: true })
  try {
    await api(`/api/connectors/${encodeURIComponent(id)}/schedule`, {
      method: "POST",
      body: JSON.stringify({ enabled, everyMinutes }),
    })
    await loadConnectors()
  } catch (e) {
    alert("Could not save the schedule: " + (e as Error).message)
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

// --- Trigger rules (per-event authored predicates) + the structured manifest --

export const fetchConnectorManifest = (id: string) =>
  api<ConnectorManifest>(`/api/connectors/${encodeURIComponent(id)}/manifest`)

export type RuleCode = {
  eventKey: string
  eventName: string
  condition: string
  builtAt: string
  author: "ai" | "human"
  status: "ok" | "stale" | "error" | "disabled" | "orphaned"
  detail?: string
  code: string
}

export const fetchRuleCode = (id: string, eventKey: string) =>
  api<RuleCode>(`/api/connectors/${encodeURIComponent(id)}/rules/${encodeURIComponent(eventKey)}/code`)

export const saveRuleCode = (id: string, eventKey: string, code: string) =>
  api<{ rule: { eventKey: string; condition: string }; skipped: boolean }>(
    `/api/connectors/${encodeURIComponent(id)}/rules/${encodeURIComponent(eventKey)}/code`,
    { method: "POST", body: JSON.stringify({ code }) },
  )

export type RulePreviewResult = {
  eventName: string
  condition: string
  status: string
  statusDetail?: string
  fired: number
  wouldEmitNow: number
  alreadyInLog: number
  noEvidence: number
  samples: { id: string; evidence: string }[]
  ruleError?: string
  log: string[]
}

export const previewRuleApi = (id: string, eventKey: string) =>
  api<RulePreviewResult>(`/api/connectors/${encodeURIComponent(id)}/rules/${encodeURIComponent(eventKey)}/preview`, {
    method: "POST",
    body: "{}",
  })

export const deleteRuleApi = (id: string, eventKey: string) =>
  api<{ removed: boolean }>(`/api/connectors/${encodeURIComponent(id)}/rules/${encodeURIComponent(eventKey)}/delete`, {
    method: "POST",
    body: "{}",
  })

export const recompileRuleApi = (id: string, eventKey: string) =>
  api<{ rule: { eventKey: string; condition: string } }>(
    `/api/connectors/${encodeURIComponent(id)}/rules/${encodeURIComponent(eventKey)}/recompile`,
    { method: "POST", body: "{}" },
  )
