// The cohort pace bar under the merged flow: one 100%-stacked strip partitioning
// EVERY case in the slice by the furthest step it has reached (grey = not
// started, deeper emerald = further along; the quarter-end goal state is the
// whole bar in the terminal colour). Segments sum to exactly the denominator —
// nothing double-counted or hidden — and each is a click-through worklist.
// When the slice is one synchronized cycle, a tick marks today as a fraction of
// the period: in a same-birthday cohort, position-vs-day-N is the only pace
// signal age can't give.
import { dayOfPeriod } from "../lib/cohort.ts"
import type { CohortStats, Period } from "../lib/cohort.ts"
import { drillToList } from "../lib/drill.ts"
import type { EventDef } from "../lib/types.ts"

type Props = {
  events: EventDef[]
  stats: CohortStats
  period: Period | null
  width: number
  /** Completed cases by the product's own rule (progressCat "done") — NOT
   * "furthest at the last declared step", which disagrees on branched models
   * and counts out-of-order terminal-only firings as complete. */
  done: number
}

const segTint = (i: number, total: number) => `rgba(16,185,129,${(0.25 + 0.65 * ((i + 1) / total)).toFixed(3)})`

export const PaceBar = ({ events, stats, period, width, done }: Props) => {
  if (!events.length || !stats.denom) {
    return null
  }
  const denom = stats.denom
  const day = period ? dayOfPeriod(period, Date.now()) : null

  const segs: { key: string; n: number; tint: string; title: string; onClick: () => void }[] = []
  if (stats.notStarted > 0) {
    segs.push({
      key: "none",
      n: stats.notStarted,
      tint: "#d6d3d1",
      title: `${stats.notStarted} case${stats.notStarted === 1 ? "" : "s"} not started (${Math.round((stats.notStarted / denom) * 100)}%) — click for the worklist`,
      onClick: () => drillToList([], { prog: "none" }),
    })
  }
  events.forEach((e, i) => {
    const n = stats.furthest[i] || 0
    if (!n) {
      return
    }
    segs.push({
      key: e.ref,
      n,
      tint: segTint(i, events.length),
      title: `${n} case${n === 1 ? "" : "s"} furthest at "${e.name}" (${Math.round((n / denom) * 100)}%) — click for the worklist`,
      onClick: () => drillToList([{ field: "furthestStep", op: "eq", value: String(i + 1) }]),
    })
  })

  return (
    <div className="mt-3" style={{ width: `${width}px` }}>
      <div className="relative">
        <div className="h-2.5 rounded overflow-hidden flex bg-stone-100">
          {segs.map((s) => (
            <button
              key={s.key}
              type="button"
              title={s.title}
              onClick={s.onClick}
              className="h-2.5 min-w-0 hover:brightness-90 transition-[filter]"
              style={{ width: `${(s.n / denom) * 100}%`, backgroundColor: s.tint }}
            />
          ))}
        </div>
        {period && day != null && (
          <div
            className="absolute -top-1 h-4 w-0.5 bg-stone-700 rounded pointer-events-none"
            style={{ left: `${Math.min(100, (day / period.days) * 100)}%` }}
            title={`Today — day ${day} of ${period.days} (${period.label})`}
          />
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-3 text-[10px] text-stone-500">
        <button
          type="button"
          onClick={() => drillToList([], { prog: "done" })}
          title="Cases that completed their branch — click for the list"
          className="font-semibold text-stone-600 tabular-nums hover:underline"
        >
          Done {done}/{denom}
        </button>
        {period && day != null && (
          <span className="tabular-nums">
            day {day} of {period.days} · {period.label}
          </span>
        )}
        <span className="ml-auto italic text-stone-400">
          every case by furthest step reached — grey = not started, darkest = furthest at the last step
          {period ? "; ▎ = today" : ""}
        </span>
      </div>
    </div>
  )
}
