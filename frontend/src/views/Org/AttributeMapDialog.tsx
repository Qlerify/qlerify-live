import { useEffect, useState } from "react"
import { api } from "@/lib/api.ts"
import type { OrgMapping } from "@/lib/types.ts"

type Props = {
  onClose: () => void
  onSaved: () => void
}

export const AttributeMapDialog = ({ onClose, onSaved }: Props) => {
  const [map, setMap] = useState<OrgMapping | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api<OrgMapping>("/org/mappings")
      .then((m) => {
        if (live) {
          setMap(m)
        }
      })
      .catch((e) => {
        if (live) {
          setMap({ error: (e as Error).message })
        }
      })
    return () => {
      live = false
    }
  }, [])

  const save = async (workflowId: string, capabilityKey: string, field: string) => {
    setBusy(true)
    setErr(null)
    try {
      const res = await api<{ mapping?: Record<string, string> }>(`/org/mappings/${workflowId}`, {
        method: "PUT",
        body: JSON.stringify({ capabilityKey, field: field || null }),
      })
      setMap((prev) => {
        if (!prev) {
          return prev
        }
        return {
          ...prev,
          workflows: (prev.workflows || []).map((w) =>
            w.id === workflowId ? { ...w, mapping: res.mapping || {} } : w,
          ),
        }
      })
      onSaved()
    } catch (e) {
      const msg = (e as Error).message
      setErr(/\b403\b/.test(msg) ? "Only organisation admins can change attribute mappings." : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col pointer-events-auto">
          <div className="px-5 py-4 border-b border-stone-200 flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">Map dashboard attributes</div>
              <div className="text-sm text-stone-500 mt-0.5">
                Point each workflow's own fields at the attributes a dashboard panel needs. Panels light up as
                workflows are mapped; partially-mapped panels flag the rest. Admin only.
              </div>
            </div>
            <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">
              ✕
            </button>
          </div>

          <div className="overflow-auto p-5 flex-1">
            {!map ? (
              <div className="py-8 text-center text-sm text-stone-500">Loading…</div>
            ) : map.error ? (
              <div className="py-8 text-center text-sm text-rose-600">{map.error}</div>
            ) : (
              (map.capabilities || []).map((cap) => (
                <div key={cap.key} className="mb-5">
                  <div className="text-sm font-semibold text-stone-800">{cap.label}</div>
                  <div className="text-xs text-stone-500 mt-0.5 mb-1">
                    {cap.description} <span className="text-stone-400">Unlocks: {cap.unlocks}</span>
                  </div>
                  {(map.workflows || []).length === 0 && (
                    <div className="text-sm text-stone-400 py-2">No workflows.</div>
                  )}
                  {(map.workflows || []).map((w) => {
                    if (!w.hasModel) {
                      return (
                        <div key={w.id} className="flex items-center gap-3 py-2 border-t border-stone-100">
                          <div className="flex-1 text-sm text-stone-500 truncate">{w.name}</div>
                          <div className="text-xs text-stone-400">no model yet</div>
                        </div>
                      )
                    }
                    const cur = w.mapping?.[cap.key] || ""
                    return (
                      <div key={w.id} className="flex items-center gap-3 py-2 border-t border-stone-100">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-stone-800 truncate">{w.name}</div>
                          {!cur && w.suggested && (
                            <div className="text-[11px] text-stone-400 mt-0.5">suggested: {w.suggested}</div>
                          )}
                        </div>
                        <select
                          value={cur}
                          disabled={busy}
                          onChange={(e) => save(w.id, cap.key, e.target.value)}
                          className="rounded-md border border-stone-300 px-2 py-1.5 text-sm max-w-[260px]"
                        >
                          <option value="">— not mapped —</option>
                          {(w.fields || []).map((f) => (
                            <option key={f.name} value={f.name}>
                              {f.dateish ? "📅 " : ""}
                              {f.name}
                              {f.dataType ? ` · ${f.dataType}` : ""}
                              {f.name === w.suggested && !cur ? " (suggested)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          {err && <div className="px-5 py-2 text-sm text-rose-600 bg-rose-50 border-t border-rose-100">{err}</div>}

          <div className="px-5 py-3 border-t border-stone-200 flex justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
