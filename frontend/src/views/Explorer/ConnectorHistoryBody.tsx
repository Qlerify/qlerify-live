import { NOTE_BADGE, connectorName } from "@/lib/connectorsData.ts"
import { kindOf } from "@/lib/explorerData.ts"
import { formatVersionDate } from "@/lib/modelData.ts"
import { useStore } from "@/lib/store.ts"
import type { ExpAdapter, ExpState } from "@/lib/types.ts"

// Connector-scoped management (re-point, timestamps, full history, delete) lives
// on the Connectors tab — its single home. This card deep-links there rather than
// duplicating those controls, especially the destructive ones. Authoring stays
// here; operating happens there.
const ConnectorCard = ({ a, bc }: { a: ExpAdapter; bc: string }) => {
  const notes = (a.doc?.notes || []).slice(-6).reverse()
  return (
    <div className="rounded-md border border-stone-200 p-2.5">
      <div className="text-sm font-medium text-stone-800">{connectorName(a, bc)}</div>
      <div className="text-xs text-stone-500 mt-0.5">
        {a.kind} · {a.mode} → {a.targetEntity}
      </div>
      {a.doc?.summary && <div className="text-xs text-stone-600 mt-1 italic">{a.doc.summary}</div>}
      {notes.length > 0 && (
        <div className="mt-2 border-t border-stone-100 pt-2 space-y-1.5">
          {notes.map((n, i) => (
            <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
              <span className={`px-1 py-0.5 rounded ${NOTE_BADGE[n.kind] || NOTE_BADGE.note} shrink-0`}>{n.kind}</span>
              <span className="flex-1 text-stone-600">{n.text}</span>
              <span className="text-stone-400 shrink-0">{formatVersionDate(n.at)}</span>
            </div>
          ))}
        </div>
      )}
      {a.kind === "connector" && (
        <div className="mt-2 pt-2 border-t border-stone-100 text-right">
          <a
            href={`#connectors/${encodeURIComponent(a.id)}`}
            title="Open this connector in the Connectors tab to re-point it, set event timestamps, view its full history, or delete it."
            className="text-[11px] text-sky-700 hover:text-sky-800 hover:underline"
          >
            Manage in Connectors →
          </a>
        </div>
      )}
    </div>
  )
}

// The History tab of the connector sidebar. Scoped to the SELECTED table so it
// matches the per-(system, table) chat thread.
export const ConnectorHistoryBody = ({ exp, onBuild }: { exp: ExpState; onBuild: () => void }) => {
  const set = useStore((s) => s.set)
  const adapters = (exp.adapters || []).filter((a) => a.targetEntity === exp.entity)

  const openChatTab = () => {
    set({ expPanelMode: "chat" })
    onBuild()
  }

  return (
    <div className="p-4 overflow-y-auto flex-1 space-y-3">
      <div className="text-xs text-stone-500">
        System <b>{exp.system || ""}</b> → {kindOf(exp, exp.entity) === "valueObject" ? "value object" : "table"}{" "}
        <b>{exp.entity || ""}</b>
      </div>
      {adapters.length ? (
        adapters.map((a) => <ConnectorCard key={a.id} a={a} bc={exp.system || ""} />)
      ) : (
        <div className="text-sm text-stone-400">No connector yet for this table — build one below.</div>
      )}
      <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-4 text-center">
        <div className="text-2xl mb-1">✨</div>
        <div className="text-sm font-medium text-stone-800">Build a connector with AI</div>
        <div className="text-xs text-stone-500 mt-1">
          Describe any source — DynamoDB, a REST API, Postgres, a Google Sheet — and the assistant writes, tests, and
          runs a connector to fill this table.
        </div>
        <button
          onClick={openChatTab}
          className="w-full mt-3 px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 font-medium"
        >
          Build connector with AI →
        </button>
      </div>
    </div>
  )
}
