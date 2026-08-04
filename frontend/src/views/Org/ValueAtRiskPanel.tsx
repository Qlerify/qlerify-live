import { MiniStat, PanelShell } from "../../components/PanelShell.tsx"
import type { OrgPortfolio } from "../../lib/types.ts"

type Props = {
  valueAtRisk: OrgPortfolio["valueAtRisk"]
  onOpenMap: () => void
  onGoWorkflow: (workflowId: string) => void
}

export const ValueAtRiskPanel = ({ valueAtRisk: v, onOpenMap, onGoWorkflow }: Props) => {
  if (!v) {
    return null
  }

  const byWorkflow = v.byWorkflow || []
  const max = Math.max(1, ...byWorkflow.map((w) => w.totalDays))

  return (
    <PanelShell eyebrow="Value at risk" title="Cost of delay, in days">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MiniStat label="Days at risk" value={v.totalDays} tone={v.totalDays > 0 ? "text-rose-700" : "text-stone-900"} />
        <MiniStat label="Overdue" value={v.overdueDays} tone="text-rose-700" />
        <MiniStat label="Projected slip" value={v.slipDays} tone="text-amber-700" />
        <MiniStat label="Over-run" value={v.overrunDays} tone="text-stone-700" />
      </div>

      {!v.hasCommitData && (
        <div className="mt-3 text-xs text-stone-500">
          Overdue & projected-slip days need a commitment date —{" "}
          <button onClick={onOpenMap} className="underline font-medium">
            map one
          </button>
          . Over-run days come from the derived baseline.
        </div>
      )}

      {byWorkflow.length > 0 ? (
        <div className="mt-3 space-y-2">
          {byWorkflow.map((w) => (
            <button key={w.workflowId} onClick={() => onGoWorkflow(w.workflowId)} className="w-full text-left">
              <div className="flex justify-between text-xs">
                <span className="text-stone-700 truncate">{w.workflowName}</span>
                <span className="font-medium text-stone-700 tabular-nums">{w.totalDays}d</span>
              </div>
              <div className="mt-0.5 h-2 bg-stone-100 rounded overflow-hidden flex">
                <div
                  className="bg-rose-500"
                  style={{ width: `${(w.overdueDays / max) * 100}%` }}
                  title={`${w.overdueDays}d overdue`}
                />
                <div
                  className="bg-amber-400"
                  style={{ width: `${(w.slipDays / max) * 100}%` }}
                  title={`${w.slipDays}d projected slip`}
                />
                <div
                  className="bg-stone-400"
                  style={{ width: `${(w.overrunDays / max) * 100}%` }}
                  title={`${w.overrunDays}d over-run`}
                />
              </div>
            </button>
          ))}
          <div className="flex gap-3 pt-1 text-[10px] text-stone-500">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-rose-500" />
              overdue
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-amber-400" />
              slip
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-stone-400" />
              over-run
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3 text-sm text-stone-400">No days at risk. 🎉</div>
      )}
    </PanelShell>
  )
}
