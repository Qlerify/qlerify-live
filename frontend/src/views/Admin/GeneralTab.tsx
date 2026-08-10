import { useState } from "react"
import { AUTH, api } from "@/lib/api.ts"
import { navigate } from "@/lib/router.ts"
import { useStore, currentOrgName } from "@/lib/store.ts"
import type { AdminData } from "@/lib/types.ts"
import { AnthropicCard } from "./AnthropicCard.tsx"
import { QlerifyCard } from "./QlerifyCard.tsx"

export const GeneralTab = ({ admin, reload }: { admin: AdminData; reload: () => Promise<void> }) => {
  const { me, orgs, set, showToast } = useStore()
  const orgId = me?.organizationId
  const curOrg: { name?: string; slug?: string } = (orgs || []).find((o) => o.id === orgId) || {}
  const orgName = curOrg.name || currentOrgName(me, orgs)
  const isSystem = curOrg.slug === "system"

  const [name, setName] = useState(orgName)
  const [nameMsg, setNameMsg] = useState<{ tone: string; text: string } | null>(null)
  const [delOpen, setDelOpen] = useState(false)
  const [delConfirm, setDelConfirm] = useState("")
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)

  const saveName = async () => {
    const n = name.trim()
    if (!n) {
      setNameMsg({ tone: "text-rose-600", text: "Name is required." })
      return
    }
    if (n === orgName) {
      setNameMsg({ tone: "text-stone-400", text: "No change." })
      return
    }
    setNameMsg({ tone: "text-stone-400", text: "Saving…" })
    try {
      const updated = await api<{ name: string }>(`/v1/organizations/${encodeURIComponent(orgId!)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: n }),
      })
      set({ me: null })
      setNameMsg({ tone: "text-emerald-700", text: `Renamed to "${updated.name}".` })
    } catch (e) {
      setNameMsg({ tone: "text-rose-600", text: (e as Error).message })
    }
  }

  const deleteOrg = async () => {
    if (delConfirm.trim() !== orgName) {
      setDelErr("The name doesn't match.")
      return
    }
    setDelBusy(true)
    try {
      await api(`/v1/organizations/${encodeURIComponent(orgId!)}`, { method: "DELETE" })
      // Prefer another accessible org; with none there's nowhere to land, so
      // sign out for a clean re-auth rather than an org-less console.
      const remaining = (orgs || []).filter((o) => o.id !== orgId)
      set({ me: null, orgs: [] })
      if (remaining.length) {
        AUTH.setOrg(remaining[0]!.id)
        showToast({ ok: true, text: `Organisation "${orgName}" was permanently deleted.` })
        navigate("#")
      } else {
        AUTH.clear()
        navigate("#login")
      }
    } catch (e) {
      setDelBusy(false)
      setDelErr((e as Error).message)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="text-sm font-semibold text-stone-900">Organisation name</div>
        <div className="text-xs text-stone-500 mt-0.5 mb-3">
          The display name shown across the console. The URL handle (slug{" "}
          <span className="mono">{curOrg.slug || "—"}</span>) stays the same.
        </div>
        <div className="flex items-end gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isSystem}
            className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-50 disabled:text-stone-400"
          />
          <button
            onClick={saveName}
            disabled={isSystem}
            className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40"
          >
            Save
          </button>
        </div>
        {nameMsg && <div className={`text-xs mt-2 ${nameMsg.tone}`}>{nameMsg.text}</div>}
        {isSystem && <div className="text-xs text-stone-400 mt-1">The system organisation can't be renamed.</div>}
      </div>

      <AnthropicCard llm={admin.anthropic} orgId={orgId} onSaved={reload} />
      <QlerifyCard q={admin.qlerify} orgId={orgId} onSaved={reload} />

      <div className="rounded-lg border border-rose-300 bg-rose-50/40 p-5">
        <div className="text-sm font-semibold text-rose-800">Danger zone</div>
        <div className="text-xs text-rose-700 mt-0.5 mb-3">
          Deleting this organisation permanently removes all of its workflows, models, data, members, and history.
          This action cannot be undone.
        </div>
        {isSystem ? (
          <div className="text-xs text-stone-500">The system organisation cannot be deleted.</div>
        ) : !delOpen ? (
          <button
            onClick={() => setDelOpen(true)}
            className="px-4 py-2 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 font-medium"
          >
            Delete this organisation
          </button>
        ) : (
          <div className="rounded-md border border-rose-300 bg-white p-3 max-w-md">
            <div className="text-xs text-stone-700 mb-2">
              This permanently deletes <b>{orgName}</b> and every workflow, model, dataset, member, and audit record
              it owns. Type <span className="mono font-semibold">{orgName}</span> below to confirm.
            </div>
            <input
              autoComplete="off"
              autoFocus
              value={delConfirm}
              onChange={(e) => setDelConfirm(e.target.value)}
              placeholder={orgName}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDelOpen(false)}
                className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
              >
                Cancel
              </button>
              <button
                onClick={deleteOrg}
                disabled={delConfirm.trim() !== orgName || delBusy}
                className="px-4 py-2 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {delBusy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
            {delErr && <div className="text-xs text-rose-600 mt-2">{delErr}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
