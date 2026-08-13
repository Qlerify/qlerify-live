import { useEffect, useRef, useState } from "react"
import { loadMonaco } from "@/lib/monaco.ts"
import { formatVersionDate } from "@/lib/modelData.ts"
import {
  connectorName, deleteRuleApi, fetchRuleCode, loadConnectors, previewRuleApi, recompileRuleApi, saveRuleCode,
  type RuleCode, type RulePreviewResult,
} from "@/lib/connectorsData.ts"
import { useStore } from "@/lib/store.ts"
import type { Connector } from "@/lib/types.ts"
import { RULE_STATUS_TONE } from "./ManifestSections.tsx"

type Editor = { getValue: () => string; setValue: (v: string) => void; dispose: () => void }

// One trigger rule's tab: a header card (event, compiled-from condition, built-at,
// drift badge) over a Monaco editor — the CodeEditor lifecycle (create once per
// key, dispose on unmount) with the rule routes behind Save / Preview / Delete.
export const RuleEditor = ({ connector, eventKey }: { connector: Connector; eventKey: string }) => {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  const [meta, setMeta] = useState<RuleCode | null>(null)
  // The change handler closes over creation time, so dirtiness is tracked against
  // a REF (updated by save/recompile), not the initial value — otherwise after a
  // recompile setValue re-fires the handler, which would compare fresh code to the
  // stale original and wrongly show "Unsaved changes", disabling Preview.
  const savedRef = useRef("")
  const [saved, setSaved] = useState("")
  const [dirty, setDirty] = useState(false)

  const markSaved = (code: string) => {
    savedRef.current = code
    setSaved(code)
    setDirty(false)
  }
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<RulePreviewResult | null>(null)
  const set = useStore((s) => s.set)

  useEffect(() => {
    let live = true
    setError(null)
    setPreview(null)
    setMeta(null)

    const build = async () => {
      try {
        const [monaco, data] = await Promise.all([loadMonaco(), fetchRuleCode(connector.id, eventKey)])
        if (!live || !host.current) {
          return
        }
        setMeta(data)
        const code = data.code || ""
        markSaved(code)
        const ed = monaco.editor.create(host.current, {
          value: code,
          language: "javascript",
          theme: "vs-dark",
          automaticLayout: true,
          readOnly: false,
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize: 13,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
          renderWhitespace: "selection",
        }) as unknown as Editor
        editor.current = ed
        ;(ed as unknown as { onDidChangeModelContent: (cb: () => void) => void }).onDidChangeModelContent(() => {
          setDirty(ed.getValue() !== savedRef.current)
        })
      } catch (e) {
        if (live) {
          setError("Couldn't load the rule: " + ((e as Error).message || String(e)))
        }
      }
    }
    build()

    return () => {
      live = false
      try {
        editor.current?.dispose()
      } catch {
        /* ignore */
      }
      editor.current = null
    }
  }, [connector.id, eventKey])

  const save = async () => {
    const ed = editor.current
    if (!ed || busy) {
      return
    }
    const code = ed.getValue()
    if (code === saved) {
      return
    }
    if (
      !confirm(
        `Save this trigger rule for "${meta?.eventName ?? eventKey}"?\n\nIt runs in-process on every derive pass (each pull, and Rebuild from data). It replaces the platform's generic heuristic for exactly this event.`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await saveRuleCode(connector.id, eventKey, code)
      markSaved(code)
      setPreview(null)
      await loadConnectors()
      const fresh = await fetchRuleCode(connector.id, eventKey)
      setMeta(fresh)
    } catch (e) {
      alert("Save failed: " + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const runPreview = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      setPreview(await previewRuleApi(connector.id, eventKey))
    } catch (e) {
      alert("Preview failed: " + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const recompile = async () => {
    if (busy) {
      return
    }
    if (
      !confirm(
        `Have AI recompile this rule from its stored condition against the CURRENT model?\n\nYour code in the editor is replaced by the fresh compile${meta?.status === "stale" ? " (this clears the stale badge)" : ""}.`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await recompileRuleApi(connector.id, eventKey)
      const fresh = await fetchRuleCode(connector.id, eventKey)
      setMeta(fresh)
      setPreview(null)
      // markSaved BEFORE setValue: setValue re-fires the change handler, which now
      // compares against savedRef — so the freshly-compiled code reads as "Saved".
      markSaved(fresh.code)
      editor.current?.setValue(fresh.code)
      await loadConnectors()
    } catch (e) {
      alert("Recompile failed: " + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy) {
      return
    }
    if (
      !confirm(
        `Delete the trigger rule for "${meta?.eventName ?? eventKey}"?\n\nThe event goes back to the platform's generic evidence heuristic on the next derive. The condition text is lost with the rule (the model's Given/When/Then is untouched).`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await deleteRuleApi(connector.id, eventKey)
      set({ connTab: "details" })
      await loadConnectors()
    } catch (e) {
      alert("Delete failed: " + (e as Error).message)
      setBusy(false)
    }
  }

  const statusText = busy ? "Working…" : dirty ? "● Unsaved changes" : "Saved"

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-6 py-3 border-b border-stone-200 bg-stone-50">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-stone-800">{meta?.eventName ?? eventKey}</span>
          {meta && (
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] ${RULE_STATUS_TONE[meta.status] || RULE_STATUS_TONE.static}`}
              title={meta.detail || undefined}
            >
              {meta.status}
            </span>
          )}
          {meta?.status === "stale" && (
            <span className="text-[11px] text-amber-700">
              the event's Given/When/Then changed since this rule was compiled
            </span>
          )}
          <span className={`text-xs ml-auto shrink-0 ${dirty && !busy ? "text-amber-600" : "text-stone-400"}`}>
            {statusText}
          </span>
          <button
            onClick={runPreview}
            disabled={busy || dirty}
            title={dirty ? "Save first — preview runs the saved rule" : "Dry-run against the live rows (nothing is emitted)"}
            className="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium shrink-0"
          >
            Preview
          </button>
          <button
            onClick={recompile}
            disabled={busy}
            title="AI-recompile from the stored condition against the current model (clears staleness)"
            className={`px-3 py-1.5 text-sm rounded-md border font-medium shrink-0 disabled:opacity-40 ${meta?.status === "stale" ? "border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100" : "border-stone-300 bg-white hover:bg-stone-50"}`}
          >
            Recompile
          </button>
          <button
            onClick={remove}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 disabled:opacity-40 font-medium shrink-0"
          >
            Delete rule
          </button>
          <button
            onClick={save}
            disabled={!dirty || busy}
            className="px-4 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium shrink-0"
          >
            Save
          </button>
        </div>
        {meta && (
          <div className="text-xs text-stone-500 mt-1.5">
            Compiled from: <span className="italic text-stone-600">{meta.condition || "(the event's Given/When/Then)"}</span>
            <span className="text-stone-400">
              {" "}
              · {meta.author === "ai" ? "AI-compiled" : "hand-edited"} {formatVersionDate(meta.builtAt)} · connector{" "}
              {connectorName(connector)}
            </span>
          </div>
        )}
        {preview && (
          <div className="mt-2 rounded-md border border-stone-200 bg-white px-3 py-2 text-xs">
            {preview.ruleError ? (
              <div className="text-rose-600">
                ⚠ rule error (the static heuristic answered instead): {preview.ruleError}
              </div>
            ) : (
              <div className="text-stone-700">
                fires for <b>{preview.fired}</b> row(s) — {preview.wouldEmitNow} would emit now, {preview.alreadyInLog}{" "}
                already in the log; {preview.noEvidence} row(s) without evidence
              </div>
            )}
            {preview.samples.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {preview.samples.map((s) => (
                  <div key={s.id} className="text-stone-500">
                    <span className="font-mono text-stone-600">{s.id}</span> — {s.evidence}
                  </div>
                ))}
              </div>
            )}
            {preview.log.length > 0 && (
              <div className="mt-1 text-stone-400 font-mono">{preview.log.slice(0, 10).join(" · ")}</div>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 relative bg-[#1e1e1e]">
        {error ? (
          <div className="absolute inset-0 p-6 text-sm text-rose-600 bg-white">{error}</div>
        ) : (
          <div ref={host} className="absolute inset-0" />
        )}
      </div>
    </div>
  )
}
