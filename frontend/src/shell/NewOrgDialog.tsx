import { useState } from "react"
import { AUTH, api } from "@/lib/api.ts"
import { navigate } from "@/lib/router.ts"
import { useStore } from "@/lib/store.ts"

export const NewOrgDialog = () => {
  const { newOrgOpen, newOrgBusy, newOrgErr, set, showToast } = useStore()
  const [name, setName] = useState("")

  if (!newOrgOpen) {
    return null
  }

  const create = async () => {
    if (newOrgBusy) {
      return
    }
    const n = name.trim()
    if (!n) {
      set({ newOrgErr: "Organization name is required" })
      return
    }
    set({ newOrgBusy: true, newOrgErr: null })
    try {
      const org = await api<{ id: string }>("/v1/organizations", {
        method: "POST",
        body: JSON.stringify({ name: n }),
      })
      AUTH.setOrg(org.id)
      set({ newOrgOpen: false, newOrgBusy: false, me: null })
      setName("")
      showToast({ ok: true, text: `Organization "${n}" created — you're its owner.` })
      navigate("#")
    } catch (e) {
      set({ newOrgBusy: false, newOrgErr: (e as Error).message || "Failed to create the organization." })
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col">
        <div className="px-5 py-4 border-b border-stone-200">
          <div className="text-lg font-semibold">Create organization</div>
          <div className="text-sm text-stone-500 mt-0.5">
            A new tenant with its own members, workflows, and data. You become its owner.
          </div>
        </div>
        <div className="p-5">
          {newOrgErr && <div className="text-sm text-rose-600 mb-3">{newOrgErr}</div>}
          <label className="block text-sm font-medium text-stone-700 mb-1">Organization name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                create()
              }
            }}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            placeholder="Acme Corp"
          />
          <div className="text-xs text-stone-500 mt-1">A URL-safe handle (slug) is derived automatically.</div>
        </div>
        <div className="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2">
          <button
            onClick={() => set({ newOrgOpen: false })}
            className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={newOrgBusy}
            className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium"
          >
            {newOrgBusy ? "Creating…" : "Create organization"}
          </button>
        </div>
      </div>
    </div>
  )
}
