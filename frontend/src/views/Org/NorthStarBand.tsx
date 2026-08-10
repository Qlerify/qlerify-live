import type { ReactNode } from "react"
import type { OrgPortfolio } from "@/lib/types.ts"

const Tile = ({ label, big, sub, tone, spark }: { label: string; big: ReactNode; sub?: string; tone?: string; spark?: ReactNode }) => (
  <div className="rounded-lg border border-stone-200 bg-white p-4">
    <div className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">{label}</div>
    <div className={`mt-1 text-2xl font-semibold tabular-nums leading-none ${tone || "text-stone-900"}`}>{big}</div>
    {sub && <div className="mt-1 text-xs text-stone-500">{sub}</div>}
    {spark}
  </div>
)

const Spark = ({ series }: { series: { week: string; count: number }[] }) => {
  const max = Math.max(1, ...series.map((s) => s.count))
  return (
    <div className="mt-2 flex items-end gap-0.5 h-6">
      {series.map((s) => (
        <div
          key={s.week}
          className="flex-1 bg-amber-300/80 rounded-sm"
          style={{ height: `${Math.max(2, Math.round((s.count / max) * 24))}px` }}
          title={`${s.week}: ${s.count}`}
        />
      ))}
    </div>
  )
}

export const NorthStarBand = ({ ns }: { ns: OrgPortfolio["northStar"] }) => {
  const flowTone = ns.flowRatio != null && ns.flowRatio < 1 ? "text-amber-700" : "text-stone-900"
  const atRiskTone = ns.atRisk > 0 ? "text-rose-700" : "text-stone-900"

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <Tile
        label="Active instances"
        big={ns.activeInstances}
        sub={`${ns.totalInstances} total · ${ns.completedInstances} done`}
      />
      <Tile
        label="At risk"
        big={ns.atRisk}
        sub={ns.cycleIndex != null ? `cycle ${ns.cycleIndex}× vs plan` : "beyond own history"}
        tone={atRiskTone}
      />
      <Tile
        label="Throughput · 8 wk"
        big={ns.completedRecent}
        sub="completed"
        spark={<Spark series={ns.throughputSeries || []} />}
      />
      <Tile
        label="Flow ratio"
        big={ns.flowRatio != null ? `${ns.flowRatio}×` : "—"}
        sub="completed ÷ started"
        tone={flowTone}
      />
      <Tile label="Twin trust" big={`${ns.twinTrust.pct}%`} sub={`${ns.twinTrust.real}/${ns.twinTrust.total} events real`} />
      <Tile
        label="Data conformance"
        big={`${ns.conformance.pct}%`}
        sub={`${ns.conformance.clean}/${ns.conformance.total} clean steps`}
      />
    </div>
  )
}
