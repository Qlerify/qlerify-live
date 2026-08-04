import { useState } from "react"
import { api } from "../../lib/api.ts"
import { ANTHROPIC_MODELS, BEDROCK_MODEL_SUGGESTIONS, BEDROCK_REGIONS } from "../../lib/adminData.ts"
import type { LlmConfig } from "../../lib/types.ts"

const providerLabel = (p?: string) => (p === "bedrock" ? "AWS Bedrock" : p === "anthropic" ? "Anthropic API" : "—")

type Props = {
  llm: LlmConfig | null
  orgId?: string | null
  onSaved: () => Promise<void>
}

export const AnthropicCard = ({ llm, orgId, onSaved }: Props) => {
  const usingOrg = !!llm && llm.source === "org"
  const [provider, setProvider] = useState(usingOrg ? llm.provider || "platform" : "platform")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState(usingOrg && llm?.provider === "anthropic" && llm.model ? llm.model : "")
  const [region, setRegion] = useState(usingOrg && llm?.provider === "bedrock" ? llm.region || "" : "")
  const [bedrockModel, setBedrockModel] = useState(usingOrg && llm?.provider === "bedrock" ? llm.model || "" : "")
  const [accessKeyId, setAccessKeyId] = useState("")
  const [secret, setSecret] = useState("")
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // The deployment pins the provider in .env — render read-only, no form.
  if (llm?.locked) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-stone-900">AI · LLM provider</div>
          <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-stone-100 border border-stone-200 text-stone-600">
            🔒 centrally managed
          </span>
        </div>
        <div className="text-xs text-stone-500 mt-0.5 mb-3">
          The server operator has locked the AI provider for this deployment (
          <span className="mono">LLM_SETTINGS_LOCKED</span>), so it cannot be changed per organisation.
        </div>
        <div className="text-xs text-stone-700 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">
          {llm.configured ? (
            <>
              AI features are <b>active</b> and pre-set to <b>{providerLabel(llm.provider)}</b> · model{" "}
              <span className="mono">{llm.model}</span>
              {llm.region && (
                <>
                  {" "}
                  · region <span className="mono">{llm.region}</span>
                </>
              )}
              .
            </>
          ) : (
            <span className="text-rose-600">
              The provider lock is on, but no platform provider is configured — contact your administrator.
            </span>
          )}
        </div>
        <div className="text-xs text-stone-400 mt-2">
          API keys and AWS credentials live in the server configuration and are never shown here.
        </div>
      </div>
    )
  }

  const save = async () => {
    if (!orgId) {
      return
    }
    const put = async (body: Record<string, unknown>, working: string, done: (r: LlmConfig) => string) => {
      setMsg({ tone: "text-stone-400", text: working })
      setBusy(true)
      try {
        const r = await api<LlmConfig>(`/v1/organizations/${encodeURIComponent(orgId)}/anthropic-config`, {
          method: "PUT",
          body: JSON.stringify(body),
        })
        await onSaved()
        setMsg({ tone: "text-emerald-700", text: done(r) })
      } catch (e) {
        setMsg({ tone: "text-rose-600", text: (e as Error).message })
      } finally {
        setBusy(false)
      }
    }

    if (provider === "platform") {
      if (!confirm("Revert to the platform default AI provider? Any AI credentials stored for your organisation will be deleted.")) {
        return
      }
      await put({ clear: true }, "Reverting…", () => "Reverted to the platform default.")
      return
    }

    if (provider === "bedrock") {
      if (!region.trim() || !bedrockModel.trim() || !accessKeyId.trim() || !secret.trim()) {
        setMsg({
          tone: "text-rose-600",
          text: "All Bedrock fields are required: region, model, access key ID, and secret access key.",
        })
        return
      }
      await put(
        { provider: "bedrock", region: region.trim(), model: bedrockModel.trim(), accessKeyId: accessKeyId.trim(), secretAccessKey: secret.trim() },
        "Validating with AWS Bedrock…",
        (r) => `Saved — now using your AWS Bedrock account ${r.hint || ""} · region ${r.region || ""} · model ${r.model || ""}.`,
      )
      return
    }

    if (!apiKey.trim()) {
      setMsg({ tone: "text-rose-600", text: "Enter an API key." })
      return
    }
    await put(
      { provider: "anthropic", apiKey: apiKey.trim(), model: model.trim() || undefined },
      "Validating key with Anthropic…",
      (r) => `Saved — now using your key ${r.hint || ""}${r.model ? ` · model ${r.model}` : ""}.`,
    )
  }

  const status = !llm ? (
    <span className="text-stone-400">checking…</span>
  ) : usingOrg && llm.provider === "bedrock" ? (
    <>
      Using <b>your AWS Bedrock account</b> · access key <span className="mono">{llm.hint}</span> · region{" "}
      <span className="mono">{llm.region}</span> · model <span className="mono">{llm.model}</span>
    </>
  ) : usingOrg ? (
    <>
      Using <b>your organisation's Anthropic key</b> <span className="mono">{llm.hint}</span>
      {llm.model && (
        <>
          {" "}
          · model <span className="mono">{llm.model}</span>
        </>
      )}
    </>
  ) : llm.configured ? (
    <>
      Using the <b>platform default</b> — {providerLabel(llm.provider)}
      {llm.model && (
        <>
          {" "}
          · model <span className="mono">{llm.model}</span>
        </>
      )}
      {llm.region && (
        <>
          {" "}
          · region <span className="mono">{llm.region}</span>
        </>
      )}
    </>
  ) : (
    <span className="text-rose-600">No AI provider configured — AI features are disabled until one is set.</span>
  )

  // Surface a legacy/custom value that isn't in the list.
  const models = ANTHROPIC_MODELS.some(([v]) => v === model)
    ? ANTHROPIC_MODELS
    : [...ANTHROPIC_MODELS, [model, `${model} (custom)`] as [string, string]]

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="text-sm font-semibold text-stone-900">AI · LLM provider</div>
      <div className="text-xs text-stone-500 mt-0.5 mb-3">
        Run this organisation's AI features (chat assistant, code &amp; connector generation) on — and billed to —
        your own account: an Anthropic API key, or your own AWS account via Bedrock. Credentials are stored
        encrypted; only a masked preview is ever shown.
      </div>
      <div className="text-xs text-stone-700 mb-3 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">
        Status: {status}
      </div>

      <label className="block text-xs text-stone-500 mb-1">Provider</label>
      <select
        value={provider}
        onChange={(e) => {
          setProvider(e.target.value)
          setMsg(null)
        }}
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3 bg-white"
      >
        <option value="platform">Platform default (managed by the server operator)</option>
        <option value="anthropic">Anthropic API — your organisation's own key</option>
        <option value="bedrock">AWS Bedrock — your organisation's own AWS account</option>
      </select>

      {provider === "platform" && (
        <div className="text-xs text-stone-500 mb-3">
          Uses whatever the server operator configured in <span className="mono">.env</span>. Saving deletes any AI
          credentials stored for this organisation.
        </div>
      )}

      {provider === "anthropic" && (
        <div>
          <label className="block text-xs text-stone-500 mb-1">Anthropic API key</label>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={usingOrg && llm?.provider === "anthropic" ? "Enter a new key to replace the current one" : "sk-ant-…"}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2"
          />
          <label className="block text-xs text-stone-500 mb-1">
            Model <span className="text-stone-400">(optional)</span>
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3 bg-white"
          >
            {models.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}

      {provider === "bedrock" && (
        <div>
          <div className="text-xs text-stone-500 mb-3">
            Enter an IAM access key from <b>your AWS account</b>, ideally scoped to{" "}
            <span className="mono">bedrock:InvokeModel</span> only. Replacing the configuration requires re-entering
            all four fields.
          </div>
          <label className="block text-xs text-stone-500 mb-1">
            AWS region <span className="text-stone-400">(where Claude is enabled)</span>
          </label>
          <input
            list="bedrock-regions-list"
            autoComplete="off"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="eu-north-1"
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2 mono"
          />
          <datalist id="bedrock-regions-list">
            {BEDROCK_REGIONS.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>

          <label className="block text-xs text-stone-500 mb-1">Bedrock model or inference-profile id</label>
          <input
            list="bedrock-models-list"
            autoComplete="off"
            value={bedrockModel}
            onChange={(e) => setBedrockModel(e.target.value)}
            placeholder="eu.anthropic.claude-sonnet-4-5-20250929-v1:0"
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-1 mono"
          />
          <datalist id="bedrock-models-list">
            {BEDROCK_MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <div className="text-[11px] text-stone-400 mb-2">
            Suggestions only — check which Claude models are enabled in your AWS console (Bedrock → Model access).
          </div>

          <label className="block text-xs text-stone-500 mb-1">AWS access key ID</label>
          <input
            autoComplete="off"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            placeholder="AKIA…"
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2 mono"
          />
          <label className="block text-xs text-stone-500 mb-1">AWS secret access key</label>
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {msg && <div className={`text-xs mt-2 ${msg.tone}`}>{msg.text}</div>}
    </div>
  )
}
