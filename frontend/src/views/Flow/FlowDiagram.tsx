import { EventCard } from "@/components/EventCard.tsx"
import { FlowEdges } from "@/components/FlowEdges.tsx"
import { CoverageBadge, coverageTone } from "@/components/CoverageBadge.tsx"
import { PaceBar } from "@/components/PaceBar.tsx"
import { computeFlowLayout, flowEdgeMid, laneMetrics, FLOW } from "@/lib/flowLayout.ts"
import type { CohortStats, Period } from "@/lib/cohort.ts"
import { drillToList } from "@/lib/drill.ts"
import { cycleFilter, ov, patchOv, stepFiredFilter, stepNotFiredFilter } from "@/lib/ovquery.ts"
import type { EventDef, Meta } from "@/lib/types.ts"

type Props = {
  events: EventDef[]
  meta: Meta
  stats: CohortStats
  period: Period | null
  /** Periods present when no single cycle dominates (mixed-cycle hint chips). */
  mixed: { label: string; count: number }[]
  filtered: { matching: number; all: number } | null
  /** Completed cases by the product's progressCat rule, for the pace bar. */
  done: number
}

// Room reserved left of the grid for the "Not started" inlet node.
const INLET_W = 132
const INLET_GAP = 48
const INLET_PITCH = INLET_W + INLET_GAP

const CHIP = "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] leading-4"

// The merged flow, re-based on distinct-case coverage: every number here is
// "cases through this step out of the slice's denominator" — the unit of the
// 100%-per-step goal — never total firings (repeats would read as progress).
// Every count is a click-through to the matching worklist.
export const FlowDiagram = ({ events, meta, stats, period, mixed, filtered, done }: Props) => {
  const denom = stats.denom
  const coveredOf = (ref: string) => stats.coveredByRef[ref] || 0
  const firedRefs = new Set(events.filter((e) => coveredOf(e.ref) > 0).map((e) => e.ref))

  const layout = computeFlowLayout(events)
  const { laneTop, laneHeight, width, height } = laneMetrics(layout, FLOW)

  const showInlet = stats.notStarted > 0 && events.length > 0
  // Inlet connectors point at the flow's entry cards: the declared first event
  // for a linear model, else every card without an in-model predecessor.
  const entryLanes = (() => {
    if (!events.length) {
      return []
    }
    const sources = layout.edges.length
      ? events.filter((e) => !layout.edges.some((ed) => ed.to === e.ref))
      : [events[0]!]
    return sources.map((e) => layout.place.get(e.ref)?.lane ?? 0)
  })()

  const a = stats.anomalies
  const anyChips = a.skipped > 0 || a.neverStarted > 0 || a.uncorrelated > 0 || a.multiFired > 0 || mixed.length > 0

  return (
    <section className="border-b border-stone-200 bg-stone-50">
      <div className="px-6 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
        {filtered && (
          <>
            <span className="text-amber-700 font-semibold">
              {filtered.matching} of {filtered.all} case{filtered.all === 1 ? "" : "s"} match the filter
            </span>
            <span className="text-stone-300">·</span>
          </>
        )}
        <span className="font-semibold text-stone-600 tabular-nums">
          {denom} case{denom === 1 ? "" : "s"}
        </span>
        {events.map((e) => {
          const covered = coveredOf(e.ref)
          const pct = denom ? Math.round((covered / denom) * 100) : 0
          return (
            <button
              key={e.ref}
              type="button"
              onClick={() => drillToList([stepNotFiredFilter(e.ref)])}
              title={`${covered} of ${denom} cases (${pct}%) through "${e.name}" — click for the ${denom - covered} not yet through`}
              className="flex items-center gap-1 tabular-nums hover:underline"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${coverageTone(pct)}`} />
              {covered}/{denom} {e.name.toLowerCase()}
            </button>
          )
        })}
        <span className="ml-auto italic text-stone-400">
          Counts are distinct cases through each step; raw firings (incl. repeats) live in the tooltips
        </span>
      </div>

      {anyChips && (
        <div className="px-6 py-1.5 flex flex-wrap items-center gap-1.5 border-b border-stone-200 bg-white">
          {a.skipped > 0 && (
            <button
              type="button"
              onClick={() => drillToList([{ field: "skippedSteps", op: "gte", value: "1" }])}
              title="Cases that fired a later step without an earlier one — coverage numbers count them as progressing, so explain them before trusting the funnel. Click for the worklist."
              className={`${CHIP} bg-rose-50 border-rose-200 text-rose-900 hover:bg-rose-100`}
            >
              ⚠ {a.skipped} skipped-step
            </button>
          )}
          {a.neverStarted > 0 && (
            <button
              type="button"
              onClick={() => drillToList([], { prog: "none" })}
              title="Cases with no events at all — invisible on the cards, which only render what fired. Click for the worklist."
              className={`${CHIP} bg-amber-50 border-amber-200 text-amber-900 hover:bg-amber-100`}
            >
              {a.neverStarted} not started
            </button>
          )}
          {a.uncorrelated > 0 && (
            <button
              type="button"
              onClick={() => drillToList([{ field: "uncorrelated", op: "gte", value: "1" }])}
              title="Event-log case ids with no case row — data drift, not pipeline: they distort every denominator until correlation is fixed. Click for the worklist."
              className={`${CHIP} bg-stone-100 border-stone-300 text-stone-700 hover:bg-stone-200`}
            >
              {a.uncorrelated} uncorrelated
            </button>
          )}
          {a.multiFired > 0 && (
            <button
              type="button"
              onClick={() => drillToList([{ field: "multiFiredSteps", op: "gte", value: "1" }])}
              title="Cases that fired a step more than once — legitimate repeat activity (not rework), shown for completeness. Click to see them."
              className={`${CHIP} bg-stone-50 border-stone-200 text-stone-500 hover:bg-stone-100`}
            >
              {a.multiFired} multi-fired
            </button>
          )}
          {mixed.slice(0, 4).map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() =>
                patchOv({ filters: [...ov().filters.filter((f) => f.field !== "cycle"), cycleFilter(c.label)] })
              }
              title={`No single cycle dominates the slice, so pace-vs-calendar is hidden. Click to narrow to exactly the ${c.count} cases of cycle ${c.label}.`}
              className={`${CHIP} bg-sky-50 border-sky-200 text-sky-900 hover:bg-sky-100`}
            >
              cycle {c.label} · {c.count}
            </button>
          ))}
        </div>
      )}

      <div id="timeline-scroll" className="px-6 py-3 overflow-x-auto">
        <div style={{ width: `${width + (showInlet ? INLET_PITCH : 0)}px` }}>
          <div
            className="relative"
            style={{
              width: `${width}px`,
              height: `${height}px`,
              marginLeft: showInlet ? `${INLET_PITCH}px` : undefined,
            }}
          >
            <FlowEdges
              layout={layout}
              laneTop={laneTop}
              laneHeight={laneHeight}
              geom={FLOW}
              width={width}
              height={height}
              firedRefs={firedRefs}
              markerId="flow-arrow"
            />

            {showInlet &&
              (() => {
                const ys = entryLanes.map((l) => laneTop[l]! + FLOW.cardH / 2)
                const yMin = Math.min(...ys)
                const yMax = Math.max(...ys)
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => drillToList([], { prog: "none" })}
                      title={`${stats.notStarted} case${stats.notStarted === 1 ? "" : "s"} with no events yet — click for the worklist`}
                      className="absolute rounded-md border border-dashed border-stone-400 bg-white/70 px-3 py-2 text-left hover:bg-stone-100 flex flex-col"
                      style={{
                        left: `${-INLET_PITCH}px`,
                        top: `${laneTop[Math.min(...entryLanes)] ?? 0}px`,
                        width: `${INLET_W}px`,
                        height: `${FLOW.cardH}px`,
                      }}
                    >
                      <span className="text-[10px] text-stone-500">Not started</span>
                      <span className="text-xl font-semibold text-stone-700 tabular-nums">{stats.notStarted}</span>
                      <span className="text-[10px] text-stone-400 mt-auto">no events yet</span>
                    </button>
                    {entryLanes.map((lane) => (
                      <div
                        key={lane}
                        className="absolute border-t-2 border-dashed border-stone-300 pointer-events-none"
                        style={{ left: `${-INLET_GAP}px`, width: `${INLET_GAP}px`, top: `${laneTop[lane]! + FLOW.cardH / 2}px` }}
                      />
                    ))}
                    {yMax > yMin && (
                      <div
                        className="absolute border-l-2 border-dashed border-stone-300 pointer-events-none"
                        style={{ left: `${-INLET_GAP}px`, top: `${yMin}px`, height: `${yMax - yMin}px` }}
                      />
                    )}
                  </>
                )
              })()}

            {events.map((e, i) => {
              const pos = layout.place.get(e.ref) || { col: i, lane: 0, idx: i }
              return (
                <EventCard
                  key={e.ref}
                  event={e}
                  index={i}
                  count={stats.firingsByRef[e.ref] || 0}
                  maxCount={1}
                  coverage={denom ? coveredOf(e.ref) / denom : 0}
                  meta={meta}
                  left={pos.col * FLOW.colPitch}
                  top={laneTop[pos.lane]!}
                  width={FLOW.cardW}
                  height={FLOW.cardH}
                />
              )
            })}

            {events.map((e, i) => {
              const pos = layout.place.get(e.ref) || { col: i, lane: 0, idx: i }
              return (
                <CoverageBadge
                  key={e.ref}
                  covered={coveredOf(e.ref)}
                  denom={denom}
                  firings={stats.firingsByRef[e.ref] || 0}
                  name={e.name}
                  cx={pos.col * FLOW.colPitch + FLOW.cardW}
                  cy={laneTop[pos.lane]!}
                  onClick={() => drillToList([stepNotFiredFilter(e.ref)])}
                />
              )
            })}

            {stats.edges.map((es) => {
              if (es.waiting === 0 && es.outOfOrder === 0) {
                return null
              }
              const pa = layout.place.get(es.from)
              const pb = layout.place.get(es.to)
              if (!pa || !pb) {
                return null
              }
              const mid = flowEdgeMid(pa, pb, layout.waypoints.get(`${es.from}->${es.to}`), laneTop, laneHeight, FLOW)
              return (
                <div
                  key={`${es.from}->${es.to}`}
                  className="absolute z-10 flex items-center gap-1 -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${mid.x}px`, top: `${mid.y}px` }}
                >
                  {es.waiting > 0 && (
                    <button
                      type="button"
                      onClick={() => drillToList([stepFiredFilter(es.from), stepNotFiredFilter(es.to)])}
                      title={`${es.waiting} case${es.waiting === 1 ? "" : "s"} through the previous step but not this one — the between-steps cohort where the flow is leaking. Click for the worklist.`}
                      className="rounded-full bg-white border border-stone-300 shadow-sm px-1.5 py-px text-[9px] font-semibold text-stone-600 tabular-nums hover:bg-stone-100"
                    >
                      {es.waiting} waiting
                    </button>
                  )}
                  {es.outOfOrder > 0 && (
                    <button
                      type="button"
                      onClick={() => drillToList([stepFiredFilter(es.to), stepNotFiredFilter(es.from)])}
                      title={`${es.outOfOrder} case${es.outOfOrder === 1 ? "" : "s"} fired this step WITHOUT the previous one — out of order. Click for the worklist.`}
                      className="rounded-full bg-rose-500 text-white shadow-sm px-1.5 py-px text-[9px] font-bold tabular-nums hover:bg-rose-600"
                    >
                      ⚠ {es.outOfOrder}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <div style={{ marginLeft: showInlet ? `${INLET_PITCH}px` : undefined }}>
            <PaceBar events={events} stats={stats} period={period} width={width} done={done} />
          </div>
        </div>
      </div>
    </section>
  )
}
