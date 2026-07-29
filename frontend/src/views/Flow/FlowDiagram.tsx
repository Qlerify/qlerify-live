import { computeFlowLayout, flowEdgePath, laneMetrics, FLOW } from "../../lib/flowLayout.ts"
import { provHatch, provModeForBC } from "../../lib/prov.ts"
import { PHASE_TONE } from "../../lib/tone.ts"
import type { EventDef, FlowAggregate, Meta } from "../../lib/types.ts"
import { ProvChip } from "../../components/ProvChip.tsx"
import { FlowCountBadge } from "../../components/FlowCountBadge.tsx"

type Props = {
  events: EventDef[]
  flow: FlowAggregate | null
  meta: Meta
}

export const FlowDiagram = ({ events, flow, meta }: Props) => {
  const counts = flow?.counts || {}
  const total = events.length
  const firedRefs = new Set(events.filter((e) => (counts[e.ref] || 0) > 0).map((e) => e.ref))
  const firedSteps = firedRefs.size
  const maxCount = Math.max(1, ...events.map((e) => counts[e.ref] || 0))

  const layout = computeFlowLayout(events)
  const { laneTop, laneHeight, width, height } = laneMetrics(layout, FLOW)
  const { cardW, cardH, colPitch } = FLOW

  const cases = flow?.totalCases ?? 0
  const pct = total ? (firedSteps / total) * 100 : 0

  return (
    <section className="border-b border-stone-200 bg-stone-50">
      <div className="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
        <span className="font-semibold text-stone-600">
          {flow?.totalFirings ?? 0} firings across {cases} case{cases === 1 ? "" : "s"}
        </span>
        <span className="text-stone-300">·</span>
        <span>
          {firedSteps} of {total} events triggered
        </span>
        <span className="ml-auto italic text-stone-400">
          The ×N badge on an event counts its firings across all cases
        </span>
      </div>

      <div id="timeline-scroll" className="px-6 py-3 overflow-x-auto">
        <div style={{ width: `${width}px` }}>
          <div className="relative" style={{ width: `${width}px`, height: `${height}px` }}>
            {layout.edges.length > 0 && (
              <svg width={width} height={height} className="absolute top-0 left-0" style={{ pointerEvents: "none" }}>
                <defs>
                  <marker
                    id="flow-arrow"
                    viewBox="0 0 8 8"
                    refX="6.5"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e" />
                  </marker>
                </defs>
                {layout.edges.map(({ from, to }) => {
                  const a = layout.place.get(from)
                  const b = layout.place.get(to)
                  if (!a || !b) {
                    return null
                  }
                  const d = flowEdgePath(a, b, layout.waypoints.get(`${from}->${to}`), laneTop, laneHeight, FLOW)
                  return (
                    <path
                      key={`${from}->${to}`}
                      d={d}
                      fill="none"
                      stroke={firedRefs.has(to) ? "#78716c" : "#e7e5e4"}
                      strokeWidth="2"
                      markerEnd="url(#flow-arrow)"
                    />
                  )
                })}
              </svg>
            )}

            {events.map((e, i) => {
              const pos = layout.place.get(e.ref) || { col: i, lane: 0, idx: i }
              const n = counts[e.ref] || 0
              const fired = n > 0
              const provMode = provModeForBC(meta, e.boundedContext)
              // Heat: relative volume → emerald tint. The floor keeps low-volume
              // fired cards visibly "on".
              const heat = fired ? (0.1 + 0.45 * (n / maxCount)).toFixed(3) : "0"
              return (
                <div
                  key={e.ref}
                  className={`absolute rounded-md border ${fired ? "border-emerald-300" : PHASE_TONE[e.phase ?? 0] || "border-stone-300"} bg-white px-3 py-2 ${fired ? "" : "opacity-60"} flex flex-col overflow-hidden`}
                  style={{
                    left: `${pos.col * colPitch}px`,
                    top: `${laneTop[pos.lane]}px`,
                    width: `${cardW}px`,
                    height: `${cardH}px`,
                    backgroundColor: fired ? `rgba(16,185,129,${heat})` : undefined,
                    backgroundImage: provHatch(provMode) || undefined,
                  }}
                >
                  <div className="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
                    <span className="truncate">
                      {i + 1}. {e.boundedContext}
                    </span>
                    <ProvChip mode={provMode} />
                  </div>
                  <div className="text-[12px] font-medium leading-tight text-stone-800">{e.name}</div>
                  <div className="text-[10px] text-stone-500 mt-1">{e.role}</div>
                </div>
              )
            })}

            {events.map((e, i) => {
              const pos = layout.place.get(e.ref) || { col: i, lane: 0, idx: i }
              const n = counts[e.ref] || 0
              return (
                <FlowCountBadge
                  key={e.ref}
                  n={n}
                  cx={pos.col * colPitch + cardW}
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
