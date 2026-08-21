import { useState } from "react"
import { AUTH, api } from "@/lib/api.ts"
import { navigate } from "@/lib/router.ts"
import { useStore } from "@/lib/store.ts"

export const NoOrg = () => {
  const { me, set } = useStore()
  const [name, setName] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const orgs = me?.organizations || []

  const create = async () => {
    const n = name.trim()
    if (!n) {
      setErr("Organisation name is required")
      return
    }
    setErr(null)
    try {
      const org = await api<{ id: string }>("/v1/organizations", {
        method: "POST",
        body: JSON.stringify({ name: n }),
      })
      AUTH.setOrg(org.id)
      set({ me: null })
      navigate("#admin")
    } catch (e) {
      setErr((e as Error).message || "Failed to create the organisation.")
    }
  }

  const openOrg = (id: string) => {
    AUTH.setOrg(id)
    set({ me: null })
    navigate("#")
  }

  return (
    <main className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-md rounded-xl border border-stone-200 bg-white p-6 shadow-sm text-center">
        <div className="text-3xl mb-2">🏢</div>
        <div className="text-lg font-semibold text-stone-900">Create your first organisation</div>
        <div className="text-sm text-stone-500 mt-1 mb-5">
          You're signed in but not a member of any organisation yet. Create one to get started — you'll be its owner.
        </div>
        <div className="text-left">
          <label className="block text-xs text-stone-500 mb-1">Organisation name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                create()
              }
            }}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3"
            placeholder="Acme Corp"
          />
          <button
            onClick={create}
            className="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800"
          >
            Create organisation
          </button>
          {err && <div className="text-xs text-rose-600 mt-2">{err}</div>}
        </div>
        {orgs.length > 0 && (
          <div className="mt-5 pt-5 border-t border-stone-200 text-left">
            <div className="text-xs text-stone-500 mb-2">Or open an existing organisation</div>
            <div className="space-y-1">
              {orgs.map((o) => (
                <button
                  key={o.id}
                  onClick={() => openOrg(o.id)}
                  className="w-full text-left px-3 py-2 rounded-md border border-stone-200 hover:bg-stone-50 text-sm"
                >
                  {o.name || o.slug}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
