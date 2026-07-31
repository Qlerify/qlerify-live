import { useState } from "react"
import { api } from "../../lib/api.ts"
import type { QlerifyConfig } from "../../lib/types.ts"

type Props = {
  q: QlerifyConfig | null
  orgId?: string | null
  onSaved: () => Promise<void>
}

export const QlerifyCard = ({ q, orgId, onSaved }: Props) => {
  const [apiKey, setApiKey] = useState("")
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const usingOrg = !!q && q.source === "org"

  const save = async () => {
    if (!apiKey.trim() || !orgId) {
      setMsg({ tone: "text-rose-600", text: "Enter an API key." })
      return
    }
    setMsg({ tone: "text-stone-400", text: "Validating key with Qlerify…" })
    setBusy(true)
    try {
      const r = await api<QlerifyConfig>(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`, {
        method: "PUT",
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      })
      await onSaved()
      setMsg({ tone: "text-emerald-700", text: `Saved — now using your key ${r.hint || ""}.` })
      setApiKey("")
    } catch (e) {
      setMsg({ tone: "text-rose-600", text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!orgId) {
      return
    }
    if (!confirm("Revert to the platform default Qlerify credentials? Your organisation's key will be removed.")) {
      return
    }
    setMsg({ tone: "text-stone-400", text: "Reverting…" })
    try {
      await api(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`, {
        method: "PUT",
        body: JSON.stringify({ clear: true }),
      })
      await onSaved()
      setMsg({ tone: "text-emerald-700", text: "Reverted to the platform default credentials." })
    } catch (e) {
      setMsg({ tone: "text-rose-600", text: (e as Error).message })
    }
  }

  const status = !q ? (
    <span className="text-stone-400">checking…</span>
  ) : usingOrg ? (
    <>
      Using <b>your organisation's key</b> <span className="mono">{q.hint}</span>
    </>
  ) : q.configured ? (
    <>
      Using the <b>platform default</b> Qlerify credentials
    </>
  ) : (
    <span className="text-rose-600">
      No Qlerify credentials configured — "Reload from link" is disabled until a key is set.
    </span>
  )

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="text-sm font-semibold text-stone-900">Modeller · Qlerify account</div>
      <div className="text-xs text-stone-500 mt-0.5 mb-3">
        Plug in your own Qlerify MCP API key so this organisation's model fetches (the Model page's "⤓ Reload from
        link") run against — and are scoped to — your own Qlerify account. The key is stored encrypted; only a masked
        preview is ever shown. Leave unset to use the platform default.
      </div>
      <div className="text-xs text-stone-700 mb-3 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">
        Status: {status}
      </div>
      <label className="block text-xs text-stone-500 mb-1">Qlerify API key</label>
      <input
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={usingOrg ? "Enter a new key to replace the current one" : "x-api-key…"}
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40"
        >
          Save key
        </button>
        {usingOrg && (
          <button
            onClick={clear}
            className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
          >
            Revert to platform default
          </button>
        )}
      </div>
      {msg && <div className={`text-xs mt-2 ${msg.tone}`}>{msg.text}</div>}
    </div>
  )
}
