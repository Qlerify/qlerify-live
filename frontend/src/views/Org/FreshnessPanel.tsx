import { navigate } from "../../lib/router.ts"
import type { OrgPortfolio } from "../../lib/types.ts"

const TONE: Record<string, { chip: string; dot: string }> = {
  ok: { chip: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  stale: { chip: "bg-rose-50 text-rose-700 border-rose-200", dot: "bg-rose-500" },
}
const DEFAULT_TONE = { chip: "bg-stone-50 text-stone-500 border-stone-200", dot: "bg-stone-400" }

export const FreshnessPanel = ({ f }: { f: OrgPortfolio["connectorFreshness"] }) => {
  if (!f) {
    return null
  }

  return (
    <section className="rounded-lg border border-stone-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-100 flex items-center gap-2">
        <div className="flex-1">
          <div className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">Connector freshness</div>
          <div className="text-sm font-semibold text-stone-800">Source-system sync health</div>
        </div>
        {f.preview && (
          <span
            className="text-[10px] uppercase font-semibold px-1.5 py-px rounded bg-amber-100 text-amber-800"
            title="Sample data — not yet wired to live connectors"
          >
            preview
          </span>
        )}
      </div>
      <div className="p-4">
        <div className="flex flex-wrap gap-2">
          {(f.sources || []).map((s) => {
            const tone = TONE[s.status] || DEFAULT_TONE
            return (
              <button
                key={s.name}
                onClick={() => navigate("#bcs")}
                title={`SLA ${s.slaMinutes}m · ${s.status}`}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border ${tone.chip} text-xs`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                <span className="font-medium">{s.name}</span>
                <span className="opacity-70">{s.lastEventAgo}</span>
              </button>
            )
          })}
        </div>
        {f.note && <div className="mt-3 text-xs text-stone-500">{f.note}</div>}
      </div>
    </section>
  )
}
