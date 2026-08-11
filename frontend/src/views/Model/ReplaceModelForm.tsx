import { useState } from "react"
import { modellerPlaceholder } from "@/lib/api.ts"
import { useStore } from "@/lib/store.ts"
import { applyWorkflowModel } from "@/lib/modelData.ts"

export const ReplaceModelForm = () => {
  const { projModelOpen, projModelBusy, projModelErr, me, set } = useStore()
  const [url, setUrl] = useState("")
  const [text, setText] = useState("")

  if (!projModelOpen) {
    return null
  }

  const apply = async () => {
    let payload: Record<string, string>
    if (url.trim()) {
      payload = { sourceUrl: url.trim() }
    } else if (text.trim()) {
      try {
        JSON.parse(text)
      } catch {
        set({ projModelErr: "The pasted/uploaded model isn't valid JSON." })
        return
      }
      payload = { workflow: text }
    } else {
      set({ projModelErr: "Paste a Qlerify model link (or upload/paste a workflow.json under Advanced)." })
      return
    }
    const ok = await applyWorkflowModel(payload)
    if (ok) {
      setUrl("")
      setText("")
    }
  }

  const readFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) {
      return
    }
    const r = new FileReader()
    r.onload = () => setText(String(r.result || ""))
    r.readAsText(f)
  }

  return (
    <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
      <div className="text-sm font-semibold text-stone-800">Replace this workflow's model</div>
      <div className="text-xs text-stone-500 mt-0.5 mb-3">
        Point the workflow at a Qlerify model. It replaces <b>this workflow's</b> model and rebuilds{" "}
        <b>this workflow's</b> data.
      </div>
      {projModelErr && <div className="text-sm text-rose-600 mb-3">{projModelErr}</div>}

      <label className="block text-sm font-medium text-stone-700 mb-1">Qlerify model link</label>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm bg-white"
        placeholder={modellerPlaceholder(me)}
      />
      <div className="text-xs text-stone-500 mt-1">
        Paste the workflow URL from the Qlerify modeller — we'll pull the latest model.
      </div>

      <details className="mt-3">
        <summary className="text-sm text-stone-600 cursor-pointer select-none hover:text-stone-900">
          Advanced — upload or paste a workflow.json instead
        </summary>
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-2">
            <input type="file" accept=".json,application/json" className="text-sm" onChange={readFile} />
            <span className="text-xs text-stone-400">— or paste below —</span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full h-40 rounded-md border border-stone-300 p-2 text-xs mono bg-white"
            placeholder='{ "boundedContext": "...", "domainEvents": { ... } }'
          />
        </div>
      </details>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          onClick={() => set({ projModelOpen: false })}
          className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
        >
          Cancel
        </button>
        <button
          onClick={apply}
          disabled={projModelBusy}
          className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium"
        >
          {projModelBusy ? "Applying…" : "Apply to workflow"}
        </button>
      </div>
    </div>
  )
}
