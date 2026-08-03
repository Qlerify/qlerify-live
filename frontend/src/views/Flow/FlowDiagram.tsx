import { computeFlowLayout, laneMetrics, FLOW } from "../../lib/flowLayout.ts"
import type { EventDef, FlowAggregate, Meta } from "../../lib/types.ts"
import { EventCard } from "../../components/EventCard.tsx"
import { FlowEdges } from "../../components/FlowEdges.tsx"
import { FlowCountBadge } from "../../components/FlowCountBadge.tsx"

type Slice = { counts: Record<string, number>; totalFirings: number; totalCases: number; allCases: number }

type Props = {
  events: EventDef[]
  flow: FlowAggregate | null
  meta: Meta
  slice?: Slice | null
}

// An active search/filter recomputes the merged counters over just the matching
// cases (client-side, from the per-case rows); otherwise the server-side
// all-cases aggregate is shown untouched.
export const FlowDiagram = ({ events, flow, meta, slice }: Props) => {
  const counts = slice ? slice.counts : flow?.counts || {}
  const total = events.length
  const firedRefs = new Set(events.filter((e) => (counts[e.ref] || 0) > 0).map((e) => e.ref))
  const firedSteps = firedRefs.size
  const maxCount = Math.max(1, ...events.map((e) => counts[e.ref] || 0))

  const layout = computeFlowLayout(events)
  const { laneTop, laneHeight, width, height } = laneMetrics(layout, FLOW)

  const cases = slice ? slice.totalCases : (flow?.totalCases ?? 0)
  const firings = slice ? slice.totalFirings : (flow?.totalFirings ?? 0)
  const pct = total ? (firedSteps / total) * 100 : 0

  return (
    <section className="border-b border-stone-200 bg-stone-50">
      <div className="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
        {slice && (
          <>
            <span className="text-amber-700 font-semibold">
              {cases} of {slice.allCases} case{slice.allCases === 1 ? "" : "s"} match the filter
            </span>
            <span className="text-stone-300">·</span>
          </>
        )}
        <span className="font-semibold text-stone-600">
          {firings} firings across {cases} case{cases === 1 ? "" : "s"}
        </span>
        <span className="text-stone-300">·</span>
        <span>
          {firedSteps} of {total} events triggered
        </span>
        <span className="ml-auto italic text-stone-400">
          The ×N badge on an event counts its firings {slice ? "across the matching cases" : "across all cases"}
        </span>
      </div>

      <div id="timeline-scroll" className="px-6 py-3 overflow-x-auto">
        <div style={{ width: `${width}px` }}>
          <div className="relative" style={{ width: `${width}px`, height: `${height}px` }}>
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
            {events.map((e, i) => {
              const pos = layout.place.get(e.ref) || { col: i, lane: 0, idx: i }
              return (
                <EventCard
                  key={e.ref}
                  event={e}
                  index={i}
                  count={counts[e.ref] || 0}
                  maxCount={maxCount}
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
              const n = counts[e.ref] || 0
              return (
                <FlowCountBadge
                  key={e.ref}
                  n={n}
                  cx={pos.col * FLOW.colPitch + FLOW.cardW}
                  cy={laneTop[pos.lane]!}
                  title={`${e.name} triggered ${n}× across all cases`}
                />
              )
            })}
          </div>

          <div className="h-1 bg-stone-200 rounded overflow-hidden mt-3" style={{ width: `${width}px` }}>
            <div className="h-1 bg-emerald-400 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    </section>
  )
}
