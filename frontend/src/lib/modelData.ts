import { api } from "./api.ts"
import { useStore } from "./store.ts"
import { showOverlay, hideOverlay } from "../components/Overlay.tsx"
import type { ModelStatus, RebuildInfo } from "./types.ts"

// Compact display form of a workflow URL — keep the tail recognisable while
// hiding the long opaque ids.
export const shortWorkflowUrl = (url: string): string => {
  try {
    const u = new URL(url)
    const parts = u.pathname.split("/").filter(Boolean)
    const last = parts[parts.length - 1] || ""
    const short = last.length > 12 ? `${last.slice(0, 8)}…${last.slice(-4)}` : last
    return `${u.host}/…/${short}`
  } catch {
    return url.length > 36 ? `${url.slice(0, 18)}…${url.slice(-12)}` : url
  }
}

export const formatVersionDate = (iso?: string): string => {
  if (!iso) {
    return ""
  }
  const d = new Date(iso)
  if (isNaN(d.getTime())) {
    return String(iso).slice(0, 16).replace("T", " ")
  }
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

// One-line tail describing the post-rebuild re-ingest + derive. Empty when the
// workflow has no connectors — the rebuilt tables just start empty.
export const rebuildSummaryText = (rebuild?: RebuildInfo): string => {
  if (!rebuild || !rebuild.connectors) {
    return ""
  }
  const ev = rebuild.derived ? rebuild.derived.events || 0 : 0
  const failed = (rebuild.failures || []).length
  const tail = failed ? ` — ${failed} connector(s) failed to pull (re-pull from the explorer)` : ""
  return ` Re-ingested ${rebuild.inserted} row(s) from ${rebuild.connectors} connector(s), derived ${ev} event(s)${tail}.`
}

const fetchModel = async () => {
  const [status, content] = await Promise.allSettled([
    api<ModelStatus>("/v1/workflow/model/status"),
    api<{ content?: string }>("/v1/workflow/model/content"),
  ])
  return { status, content }
}

export const loadModel = async () => {
  const set = useStore.getState().set
  set({ modelStatus: null, modelContent: null, modelNoContent: false })

  const { status, content } = await fetchModel()
  set({
    modelStatus:
      status.status === "fulfilled"
        ? status.value
        : { versions: [], current: -1, total: 0, currentVersion: null, sourceUrl: null },
  })

  if (content.status === "fulfilled") {
    set({ modelContent: content.value.content || "" })
  } else {
    set({ modelContent: null, modelNoContent: true })
    if (!useStore.getState().projModelOpen) {
      set({ projModelOpen: true })
    }
  }
}

export const refreshModelPage = async () => {
  const set = useStore.getState().set
  const { status, content } = await fetchModel()
  if (status.status === "fulfilled") {
    set({ modelStatus: status.value })
  }
  if (content.status === "fulfilled") {
    set({ modelContent: content.value.content || "", modelNoContent: false, projModelOpen: false })
  }
}

// A model change rebuilds the workflow, so the tenant context is refetched too.
const afterModelChange = async () => {
  await refreshModelPage()
  useStore.getState().set({ me: null })
}

export const reloadWorkflowModel = async () => {
  const s = useStore.getState()
  if (s.modelBusy) {
    return
  }
  s.set({ modelBusy: true })
  showOverlay("Reloading model…")
  try {
    const res = await api<{ rebuild?: RebuildInfo }>("/v1/workflow/model/reload", { method: "POST", body: "{}" })
    useStore.getState().showToast({
      ok: true,
      text: "Reloaded the latest model from the source link — rebuilt this workflow." + rebuildSummaryText(res.rebuild),
    })
    await afterModelChange()
  } catch (e) {
    // Leave an error visible — it's often actionable config advice.
    useStore.getState().showToast({ ok: false, text: (e as Error).message || "Reload failed." })
  } finally {
    useStore.getState().set({ modelBusy: false })
    hideOverlay()
  }
}

export const restoreWorkflowVersion = async (versionId: string) => {
  const s = useStore.getState()
  if (s.modelBusy || !versionId) {
    return
  }
  s.set({ modelBusy: true })
  showOverlay("Restoring model…")
  try {
    const res = await api<{ rebuild?: RebuildInfo }>("/v1/workflow/model/restore", {
      method: "POST",
      body: JSON.stringify({ versionId }),
    })
    useStore.getState().showToast({
      ok: true,
      text: "Restored that version — rebuilt this workflow." + rebuildSummaryText(res.rebuild),
    })
    await afterModelChange()
  } catch (e) {
    useStore.getState().showToast({ ok: false, text: (e as Error).message || "Restore failed." })
  } finally {
    useStore.getState().set({ modelBusy: false })
    hideOverlay()
  }
}

export const applyWorkflowModel = async (payload: Record<string, string>) => {
  const s = useStore.getState()
  s.set({ projModelBusy: true, projModelErr: null })
  showOverlay("Loading model…")
  try {
    const res = await api<{ rebuild?: RebuildInfo }>("/v1/workflow/model", {
      method: "PUT",
      body: JSON.stringify(payload),
    })
    useStore.getState().set({ projModelOpen: false, projModelBusy: false })
    useStore.getState().showToast({
      ok: true,
      text: "Workflow model updated — rebuilt this workflow." + rebuildSummaryText(res.rebuild),
    })
    await afterModelChange()
    return true
  } catch (e) {
    useStore.getState().set({
      projModelBusy: false,
      projModelErr: (e as Error).message || "Failed to set the model.",
    })
    return false
  } finally {
    hideOverlay()
  }
}
