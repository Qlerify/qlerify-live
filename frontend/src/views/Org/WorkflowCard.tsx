import { PROV_STYLE } from "@/components/ProvChip.tsx"
import type { OrgWorkflowCard, TwinTrust } from "@/lib/types.ts"

// Colour follows the provenance ladder.
const TrustChip = ({ tp }: { tp: TwinTrust }) => {
  const mode = tp.pct >= 50 ? "live" : tp.pct > 0 ? "recorded" : "simulated"
  const s = PROV_STYLE[mode] || PROV_STYLE.simulated!
  return (
    <span
      className={`text-[9px] font-semibold px-1 py-px rounded ${s.chip}`}
      title={`${tp.real}/${tp.total} events from a real source`}
    >
      {tp.pct}% real
    </span>
  )
}

export const WorkflowCard = ({ w, onOpen }: { w: OrgWorkflowCard; onOpen: () => void }) => {
  if (!w.hasModel) {
    return (
      <button
        onClick={onOpen}
        className="text-left rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 hover:border-stone-400 transition"
      >
        <div className="font-semibold text-stone-700 truncate">{w.name}</div>
        <div className="text-xs text-stone-500 mt-1">No model yet — open to set one.</div>
      </button>
    )
  }

  const role = w.topRoleQueue
  const oldest = w.oldestActive
  const hasChips = !!(w.atRisk || w.reworkCount || w.softFailCount)

  return (
    <button
      onClick={onOpen}
      className="text-left rounded-lg border border-stone-200 bg-white p-4 hover:border-amber-300 hover:shadow-sm transition"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-stone-900 truncate">{w.name}</div>
        <TrustChip tp={w.twinTrust} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-xl font-semibold text-stone-900 tabular-nums">{w.active}</div>
          <div className="text-[10px] uppercase text-stone-500">active</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-stone-900 tabular-nums">{w.completed}</div>
          <div className="text-[10px] uppercase text-stone-500">done</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-stone-900 tabular-nums">{w.throughputRecent}</div>
          <div className="text-[10px] uppercase text-stone-500">8wk</div>
        </div>
      </div>

      <div className="mt-3 space-y-1 text-xs text-stone-600">
        {role && (
          <div className="flex justify-between gap-2">
            <span className="text-stone-500">Top queue</span>
            <span className="font-medium truncate">
              {role.role} · {role.count}
            </span>
          </div>
        )}
        {w.cycleIndex != null && (
          <div className="flex justify-between gap-2">
            <span className="text-stone-500">Cycle time</span>
            <span className={`font-medium ${w.cycleIndex > 1.2 ? "text-amber-700" : "text-stone-700"}`}>
              {w.cycleIndex}× vs plan{w.expectedDays != null ? ` · ~${w.expectedDays}d` : ""}
            </span>
          </div>
        )}
        {oldest && (
          <div className="flex justify-between gap-2">
            <span className="text-stone-500">Oldest active</span>
            <span className="font-medium truncate">
              {oldest.stepName} · {oldest.ageDays}d
            </span>
          </div>
        )}
        {hasChips && (
          <div className="flex gap-1.5 pt-1 flex-wrap">
            {!!w.atRisk && (
              <span className="px-1.5 py-px rounded bg-rose-200 text-rose-800 text-[11px] font-medium">
                {w.atRisk} at risk
              </span>
            )}
            {!!w.reworkCount && (
              <span className="px-1.5 py-px rounded bg-rose-100 text-rose-700 text-[11px]">{w.reworkCount} rework</span>
            )}
            {!!w.softFailCount && (
              <span className="px-1.5 py-px rounded bg-stone-200 text-stone-600 text-[11px]">
                {w.softFailCount} soft-fail
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 text-[10px] text-stone-400">{w.totalSteps} steps</div>
    </button>
  )
}
