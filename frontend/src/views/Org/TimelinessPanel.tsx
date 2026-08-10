import { MiniStat, PanelShell } from "@/components/PanelShell.tsx"
import type { OrgPortfolio } from "@/lib/types.ts"

type Props = {
  o: OrgPortfolio
  onOpenMap: () => void
  onGoCase: (workflowId: string, caseId: string) => void
}

export const TimelinessPanel = ({ o, onOpenMap, onGoCase }: Props) => {
  const cap = (o.capabilities || []).find((c) => c.key === "commitDate")
  if (!cap) {
    return null
  }

  if (cap.state === "locked") {
    return (
      <PanelShell eyebrow="Timeliness" title="Overdue & on-time commitments">
        <div className="flex items-center gap-4 rounded-md border border-dashed border-stone-300 bg-stone-50 p-4">
          <div className="text-2xl">🔒</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-stone-700">This panel needs a commitment / due date</div>
            <div className="text-xs text-stone-500 mt-0.5">{cap.description}</div>
          </div>
          <button
            onClick={onOpenMap}
            className="shrink-0 px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800"
          >
            Map attributes →
          </button>
        </div>
      </PanelShell>
    )
  }

  const t = o.timeliness || { overdue: 0, predictedLate: 0, onTime: 0, scorable: 0, rows: [], partial: null }
  const rows = t.rows || []
  const unmapped = t.partial?.unmapped.length ?? 0

  return (
    <PanelShell eyebrow="Timeliness" title="Overdue, predicted-late & on-time commitments">
      {unmapped > 0 && (
        <div className="mb-3 flex items-center gap-1.5 flex-wrap text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          ⚠ {unmapped} workflow{unmapped === 1 ? "" : "s"} not mapped yet —{" "}
          <button onClick={onOpenMap} className="underline font-medium">
            map {unmapped === 1 ? "it" : "them"}
          </button>{" "}
          to include their commitments.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MiniStat label="Overdue" value={t.overdue} tone="text-rose-700" />
        <MiniStat label="Predicted late" value={t.predictedLate ?? 0} tone="text-amber-700" />
        <MiniStat label="On time" value={t.onTime} tone="text-emerald-700" />
        <MiniStat label="Scorable" value={t.scorable} tone="text-stone-700" />
      </div>

      {rows.length > 0 ? (
        <div className="mt-3 divide-y divide-stone-100 rounded-md border border-stone-200 overflow-hidden">
          {rows.map((r) => {
            const late = r.kind === "overdue"
            return (
              <button
                key={`${r.workflowId}-${r.caseId}`}
                onClick={() => onGoCase(r.workflowId, r.caseId)}
                className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50"
              >
                <span className={`inline-block w-2 h-2 rounded-full ${late ? "bg-rose-500" : "bg-amber-400"} shrink-0`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-stone-800 truncate">
                    {r.workflowName} · {r.caseId.slice(0, 12)}…
                  </div>
                  <div className="text-[11px] text-stone-500">
                    due {r.dueDate}
                    {!late && ` · projected ${r.predictedFinish || "—"}`}
                  </div>
                </div>
                <span
                  className={`text-[11px] font-medium ${late ? "text-rose-700" : "text-amber-700"} tabular-nums shrink-0`}
                >
                  {late ? `${r.days}d late` : `~${r.days}d slip`}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="mt-3 text-sm text-stone-400">No overdue or predicted-late commitments. 🎉</div>
      )}
    </PanelShell>
  )
}
