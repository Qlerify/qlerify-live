// Burn-up small multiples — the forward-looking panel: one mini chart per step,
// cumulative distinct-case coverage over the cycle vs the straight line required
// to land 100% by period end, plus a dashed projection at the current 14-day
// pace. For a synchronized cohort the straight target line is genuinely correct
// (0% at cycle start, 100% at cycle end), so the gap between the lines IS the
// projected shortfall — visible in week 3 instead of week 12. First-firing
// business timestamps are exactly the coverage events, so no new data is needed.
// Rendered only when one cycle dominates the slice (mixed cycles have no shared
// clock to plot against).
import { dayOfPeriod } from "../../lib/cohort.ts"
import type { Period } from "../../lib/cohort.ts"
import type { CaseRecord } from "../../lib/ovquery.ts"
import type { EventDef } from "../../lib/types.ts"

const W = 180
const H = 64
const X0 = 2
const X1 = W - 2
const Y0 = 6
const Y1 = H - 6

type Props = {
  records: CaseRecord[]
  events: EventDef[]
  period: Period
}

const xOf = (p: Period, t: number) => X0 + ((X1 - X0) * (t - p.start)) / (p.end - p.start)
const yOf = (pct: number) => Y1 - ((Y1 - Y0) * pct) / 100

const StepBurnup = ({ name, index, times, denom, period, now }: {
  name: string
  index: number
  times: number[]
  denom: number
  period: Period
  now: number
}) => {
  const nowX = Math.min(now, period.end)
  const covAt = (t: number) => {
    let n = 0
    for (const ts of times) {
      if (ts <= t) {
        n++
      } else {
        break
      }
    }
    return (n / denom) * 100
  }

  // Daily polyline from cycle start to today.
  const pts: string[] = [`${xOf(period, period.start).toFixed(1)},${yOf(0).toFixed(1)}`]
  for (let t = period.start + 86400000; t <= nowX; t += 86400000) {
    pts.push(`${xOf(period, t).toFixed(1)},${yOf(covAt(t)).toFixed(1)}`)
  }
  pts.push(`${xOf(period, nowX).toFixed(1)},${yOf(covAt(nowX)).toFixed(1)}`)

  const covNow = covAt(nowX)
  // Projection: extrapolate the last 14 days' slope to period end.
  const lookback = Math.max(period.start, nowX - 14 * 86400000)
  const daysBack = Math.max(1, (nowX - lookback) / 86400000)
  const slope = (covNow - covAt(lookback)) / daysBack
  const daysLeft = Math.max(0, (period.end - nowX) / 86400000)
  const projected = Math.min(100, Math.max(covNow, covNow + slope * daysLeft))
  const showProj = covNow < 100 && daysLeft > 0

  return (
    <div className="shrink-0" style={{ width: `${W}px` }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="bg-white rounded border border-stone-200">
        {/* required-to-100% reference: straight from cycle start to cycle end */}
        <line x1={xOf(period, period.start)} y1={yOf(0)} x2={X1} y2={yOf(100)} stroke="#d6d3d1" strokeWidth="1" />
        {/* today rule */}
        <line
          x1={xOf(period, nowX)}
          y1={Y0}
          x2={xOf(period, nowX)}
          y2={Y1}
          stroke="#a8a29e"
          strokeWidth="1"
          strokeDasharray="2,2"
        />
        {/* cumulative coverage */}
        <polyline points={pts.join(" ")} fill="none" stroke="#059669" strokeWidth="1.5" />
        {/* projection at current pace */}
        {showProj && (
          <line
            x1={xOf(period, nowX)}
            y1={yOf(covNow)}
            x2={X1}
            y2={yOf(projected)}
            stroke="#f59e0b"
            strokeWidth="1.5"
            strokeDasharray="4,3"
          />
        )}
      </svg>
      <div className="mt-0.5 flex items-baseline gap-1 text-[10px]">
        <span className="text-stone-600 font-medium truncate" title={name}>
          {index + 1}. {name}
        </span>
        <span className="ml-auto tabular-nums text-stone-500 shrink-0">
          {Math.round(covNow)}%
          {showProj && (
            <>
              {" → "}
              <span className={projected >= 99.5 ? "text-emerald-700 font-semibold" : "text-amber-700 font-semibold"}>
                proj {Math.round(projected)}%
              </span>
            </>
          )}
        </span>
      </div>
    </div>
  )
}

export const BurnupStrip = ({ records, events, period }: Props) => {
  const denom = records.length
  if (!denom || !events.length) {
    return null
  }
  const now = Date.now()
  if (now < period.start) {
    return null
  }
  const day = dayOfPeriod(period, now)

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">
          Burn-up per step — {period.label}
        </span>
        <span className="text-[10px] text-stone-400">
          day {day} of {period.days} · solid = coverage so far · straight grey = required for 100% by cycle end ·
          dashed = projection at the last 14 days' pace
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-3">
        {events.map((e, i) => {
          const nowX = Math.min(now, period.end)
          const times = records
            .map((r) => {
              if (!(r.fr?.counts?.[e.ref] || 0)) {
                return NaN // never fired: stays out of the numerator
              }
              const inCycle = r.id.slice(r.id.lastIndexOf("@") + 1) === period.label
              const t = r.fr?.times?.[e.ref]?.businessAt
              const ms = t ? Date.parse(t) : NaN
              if (!isFinite(ms)) {
                // Covered but unstamped (the server omits times when no source
                // timestamp anchors the firing): the badge counts it, so the
                // curve must too — anchor the cycle's own cases at cycle start;
                // foreign-cycle cases have no honest position on this axis.
                return inCycle ? period.start : NaN
              }
              if (ms < period.start) {
                // Early strays: clamp the cycle's own cases to cycle start; a
                // foreign cycle's history is NOT day-zero coverage of this one.
                return inCycle ? period.start : NaN
              }
              // Late/future stamps clamp to the today rule so covNow matches
              // the coverage badge.
              return Math.min(ms, nowX)
            })
            .filter((ms) => isFinite(ms))
            .sort((a, b) => a - b)
          return (
            <StepBurnup key={e.ref} name={e.name} index={i} times={times} denom={denom} period={period} now={now} />
          )
        })}
      </div>
    </div>
  )
}
