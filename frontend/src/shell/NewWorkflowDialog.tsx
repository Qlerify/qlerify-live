import { useState } from "react"
import { AUTH, api } from "../lib/api.ts"
import { navigate } from "../lib/router.ts"
import { useStore } from "../lib/store.ts"

export const NewWorkflowDialog = () => {
  const { newWfOpen, newWfBusy, newWfErr, set } = useStore()
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [text, setText] = useState("")

  if (!newWfOpen) {
    return null
  }

  const create = async () => {
    if (newWfBusy) {
      return
    }
    // The name is OPTIONAL: left blank, the server takes it from the loaded
    // model (the modeller's workflow name, else its title/boundedContext).
    const n = name.trim()

    let modelPayload: Record<string, string>
    if (url.trim()) {
      modelPayload = { sourceUrl: url.trim() }
    } else if (text.trim()) {
      try {
        JSON.parse(text)
      } catch {
        set({ newWfErr: "The pasted/uploaded model isn't valid JSON." })
        return
      }
      modelPayload = { workflow: text }
    } else {
      set({
        newWfErr: "A model is required — paste a Qlerify link (or upload/paste a workflow.json under Advanced).",
      })
      return
    }

    set({ newWfBusy: true, newWfErr: null })
    try {
      const wss = await api<{ id: string }[]>("/v1/workspaces")
      const workspaceId = (wss[0] || {}).id
      if (!workspaceId) {
        throw new Error("This org has no workspace — create one in Org Admin first.")
      }
      const wf = await api<{ id: string }>("/v1/workflows", {
        method: "POST",
        body: JSON.stringify({ ...(n ? { name: n } : {}), workspaceId, ...modelPayload }),
      })
      AUTH.setWorkflow(wf.id)
      set({ newWfOpen: false, newWfBusy: false, me: null })
      setName("")
      setUrl("")
      setText("")
      navigate("#")
    } catch (e) {
      set({ newWfBusy: false, newWfErr: (e as Error).message || "Failed to create the workflow." })
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
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[88vh]">
        <div className="px-5 py-4 border-b border-stone-200">
          <div className="text-lg font-semibold">Create workflow</div>
          <div className="text-sm text-stone-500 mt-0.5">
            Point it at a Qlerify model — the workflow and its model are created together, and the name is taken from
            the loaded workflow unless you type one.
          </div>
        </div>
        <div className="p-5 overflow-auto flex-1">
          {newWfErr && <div className="text-sm text-rose-600 mb-3">{newWfErr}</div>}
          <label className="block text-sm font-medium text-stone-700 mb-1">Qlerify model link</label>
          <input
            autoFocus
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                create()
              }
            }}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            placeholder="https://app.qlerify.com/workflow/<projectId>/<workflowId>"
          />
          <div className="text-xs text-stone-500 mt-1">
            Paste the workflow URL from the Qlerify modeller — we'll pull the latest model.
          </div>
          <label className="block text-sm font-medium text-stone-700 mb-1 mt-4">
            Workflow name <span className="font-normal text-stone-400">(optional)</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                create()
              }
            }}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            placeholder="Defaults to the loaded workflow's name"
          />
          <details className="mt-4">
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
                className="w-full h-40 rounded-md border border-stone-300 p-2 text-xs mono"
                placeholder='{ "boundedContext": "...", "domainEvents": { ... } }'
              />
            </div>
          </details>
        </div>
        <div className="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2">
          <button
            onClick={() => set({ newWfOpen: false })}
            className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={newWfBusy}
            className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium"
          >
            {newWfBusy ? "Creating…" : "Create workflow"}
          </button>
        </div>
      </div>
    </div>
  )
}
