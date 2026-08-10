import { useEffect, useRef, useState } from "react"
import { loadMonaco } from "@/lib/monaco.ts"
import { connectorName, fetchConnectorCode, loadConnectors, saveConnectorCode } from "@/lib/connectorsData.ts"
import { useStore } from "@/lib/store.ts"
import type { Connector } from "@/lib/types.ts"

type Editor = { getValue: () => string; setValue: (v: string) => void; dispose: () => void }

// Monaco is created once per connector and disposed on unmount. React keeps the
// host node stable across re-renders, so the legacy re-parenting dance is gone.
export const CodeEditor = ({ connector }: { connector: Connector }) => {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  const [saved, setSaved] = useState("")
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setError(null)

    const build = async () => {
      try {
        const [monaco, data] = await Promise.all([loadMonaco(), fetchConnectorCode(connector.id)])
        if (!live || !host.current) {
          return
        }
        const code = data.code || ""
        setSaved(code)
        const ed = monaco.editor.create(host.current, {
          value: code,
          language: "javascript",
          theme: "vs-dark",
          automaticLayout: true,
          readOnly: false,
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize: 13,
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          tabSize: 2,
          renderWhitespace: "selection",
        }) as unknown as Editor
        editor.current = ed
        ;(ed as unknown as { onDidChangeModelContent: (cb: () => void) => void }).onDidChangeModelContent(() => {
          setDirty(ed.getValue() !== code)
        })
      } catch (e) {
        if (live) {
          setError("Couldn't load the code editor: " + ((e as Error).message || String(e)))
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
  }, [connector.id])

  const revert = () => {
    if (!editor.current || busy || !dirty) {
      return
    }
    if (!confirm("Discard your unsaved changes and revert to the last saved code?")) {
      return
    }
    editor.current.setValue(saved)
    setDirty(false)
  }

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
        `Save and register this code for connector "${connectorName(connector)}"?\n\nIt runs in the connector sandbox on the next Test or Fetch. Any npm packages it imports are installed now. This does not pull data yet.`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const r = await saveConnectorCode(connector.id, code)
      setSaved(code)
      setDirty(false)
      await loadConnectors()
      const pkgs = (r.deps || []).length
        ? `Installed/checked packages: ${(r.deps || []).join(", ")}.`
        : "No external packages imported."
      const failed = r.install && r.install.ok === false ? `\n\n⚠ Package install reported a problem:\n${r.install.log || ""}` : ""
      alert(`Saved ${r.bytes} byte(s). ${pkgs}${failed}\n\nTest it (Details → Test, or Fetch rows) to run it.`)
    } catch (e) {
      alert("Save failed: " + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // "Saving…" keys off the local save flag only — other busy ops (export,
  // verify) can run while the Code tab is mounted and must not look like a save.
  const connBusy = useStore((s) => s.connBusy)
  const statusText = busy ? "Saving…" : dirty ? "● Unsaved changes" : "Saved"

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-6 py-2 border-b border-stone-200 bg-stone-50">
        <span className="text-xs text-stone-500 truncate">
          Runs in the connector sandbox on <b>Test</b> / <b>Fetch</b>. Saving installs any npm packages it imports — it
          does not pull data.
        </span>
        <span className={`text-xs ml-auto shrink-0 ${dirty && !busy ? "text-amber-600" : "text-stone-400"}`}>
          {statusText}
        </span>
        <button
          onClick={revert}
          disabled={!dirty || busy || connBusy}
          className="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium shrink-0"
        >
          Revert
        </button>
        <button
          onClick={save}
          disabled={!dirty || busy || connBusy}
          className="px-4 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium shrink-0"
        >
          Save
        </button>
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
