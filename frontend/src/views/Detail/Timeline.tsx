import { useEffect } from "react"
import { useStore } from "../../lib/store.ts"
import { computeFlowLayout, flowEdgePath, FLOW, ROUTE_ROW } from "../../lib/flowLayout.ts"
import { businessByStep, expandedCardHeight, firedCountMap, firedRefSet, firingsByRefMap } from "../../lib/detailData.ts"
import { EST_TIME_TITLE, bizTimeEstimated, fmtBizDate, fmtGap, minutesBetween } from "../../lib/time.ts"
import { provHatch, provModeForBC } from "../../lib/prov.ts"
import { PHASE_TONE } from "../../lib/tone.ts"
import { navSelect } from "../../lib/navSelect.ts"
import type { Direction } from "../../lib/navSelect.ts"
import { ProvChip } from "../../components/ProvChip.tsx"
import { FiredCountBadge } from "../../components/FiredCountBadge.tsx"
import { TimelineLegend } from "./TimelineLegend.tsx"
import { SplitTimeline } from "./SplitTimeline.tsx"

const LONG_GAP_MIN = 10 * 1440
const ARROW_DIRS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
}

export const Timeline = () => {
  const { events, log, meta, expandedFirings, selectedStep, splitRef, set } = useStore()

  const total = events.length
  const firedRefs = firedRefSet(log)
  const firedCounts = firedCountMap(log)
  const firingsByRef = firingsByRefMap(log)
  const biz = businessByStep(log)
  const pct = total ? (firedRefs.size / total) * 100 : 0

  const layout = computeFlowLayout(events)
  const { cardW, cardH, colPitch, rowPitch } = FLOW

  // Arrow keys move the selection around the flow — only while one is selected,
  // so unselected arrows keep normal page scrolling. Skipped while typing.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const s = useStore.getState()
      if (s.selectedStep == null) {
        return
      }
      const dir = ARROW_DIRS[ev.key]
      if (!dir) {
        return
      }
      const a = document.activeElement
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || (a as HTMLElement).isContentEditable)) {
        return
      }
      ev.preventDefault()
      const next = navSelect(s.events, s.selectedStep, dir)
      if (next != null) {
        s.set({ selectedStep: next })
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  // Branch split takes over the whole flow area, while the split event still
  // fired more than once for this case.
  if (splitRef && (firedCounts.get(splitRef) || 0) > 1) {
    return (
      <SplitTimeline
        events={events}
        log={log}
        layout={layout}
        splitRef={splitRef}
        firedCounts={firedCounts}
        onMerge={() => set({ splitRef: null })}
      />
    )
  }

  const isExpanded = (ref: string) => expandedFirings.has(ref) && (firedCounts.get(ref) || 0) > 1
  const cardHeightFor = (ref: string) => (isExpanded(ref) ? expandedCardHeight(firedCounts.get(ref)!) : cardH)

  // Push-down reflow: a lane is as tall as its tallest card, and each lane's Y is
  // the cumulative height above it plus the usual gutter. With nothing expanded
  // this is exactly the uniform rowPitch grid.
  const laneGap = rowPitch - cardH
  const cardLanes = new Set(Array.from(layout.place.values(), (p) => p.lane))
  const laneHeight = Array.from({ length: layout.lanes }, (_, L) => (cardLanes.has(L) ? cardH : ROUTE_ROW))
  for (const e of events) {
    const pos = layout.place.get(e.ref)
    if (pos) {
      laneHeight[pos.lane] = Math.max(laneHeight[pos.lane]!, cardHeightFor(e.ref))
    }
  }
  const laneTop: number[] = []
  let acc = 0
  for (let L = 0; L < layout.lanes; L++) {
    laneTop[L] = acc
    acc += laneHeight[L]! + laneGap
  }

  const W = (layout.cols - 1) * colPitch + cardW
  const H = layout.lanes ? laneTop[layout.lanes - 1]! + laneHeight[layout.lanes - 1]! : cardH

  // The most-recently-fired step in declared order — the "latest" cursor.
  let lastFiredIndex = -1
  events.forEach((e, i) => {
    if (firedRefs.has(e.ref)) {
      lastFiredIndex = i
    }
  })

  const toggleFirings = (ref: string) => {
    const next = new Set(expandedFirings)
    if (next.has(ref)) {
      next.delete(ref)
    } else {
      next.add(ref)
    }
    set({ expandedFirings: next })
  }

  // Business-date gaps accumulate in declared order, so this runs outside the map.
  // A gap read off an estimated endpoint is itself an estimate.
  let prevBizIso: string | null = null
  let prevBizEst = false
  const gapByRef = new Map<string, { min: number | null; est: boolean }>()
  for (const e of events) {
    if (!firedRefs.has(e.ref)) {
      continue
    }
    const bz = biz.get(e.ref)
    const min = prevBizIso && bz ? minutesBetween(prevBizIso, bz.iso) : null
    gapByRef.set(e.ref, { min, est: min != null && (!!bz?.est || prevBizEst) })
    if (bz) {
      prevBizIso = bz.iso
      prevBizEst = bz.est
    }
  }

  return (
    <section className="border-b border-stone-200 bg-stone-50">
      <TimelineLegend />
      <div id="timeline-scroll" className="px-6 py-3 overflow-x-auto">
        <div style={{ width: `${W}px` }}>
          <div className="relative" style={{ width: `${W}px`, height: `${H}px` }}>
            {layout.edges.length > 0 && (
              <svg width={W} height={H} className="absolute top-0 left-0" style={{ pointerEvents: "none" }}>
                <defs>
                  <marker
                    id="detail-arrow"
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
                      markerEnd="url(#detail-arrow)"
                    />
                  )
                })}
              </svg>
            )}

            {events.map((e, i) => {
              const pos = layout.place.get(e.ref) || { col: i, lane: 0, idx: i }
              const fired = firedRefs.has(e.ref)
              const isCurrent = i === lastFiredIndex
              const isSelected = i === selectedStep
              const provMode = provModeForBC(meta, e.boundedContext)
              const open = isExpanded(e.ref)
              // Selection (sky) wins over the amber "latest fired" ring.
              const ring = isSelected ? "ring-2 ring-sky-500" : isCurrent ? "ring-2 ring-amber-400" : ""
              const bz = biz.get(e.ref)
              const bizLabel = fired ? fmtBizDate(bz?.iso) : null
              const gap = gapByRef.get(e.ref)
              const gapMin = gap?.min ?? null
              // An alarm colour on an inferred number would signal false
              // confidence, so estimated gaps stay muted and ~-prefixed.
              const gapTone =
                gapMin != null && gapMin >= LONG_GAP_MIN && !gap?.est
                  ? "text-amber-700 font-semibold"
                  : "text-stone-500"

              let prevIso: string | null = null
              let prevEst = false

              return (
                <div
                  key={e.ref}
                  title="View the data as of this event"
                  onClick={() => set({ selectedStep: i })}
                  className={`absolute cursor-pointer rounded-md border ${fired ? "border-emerald-200" : PHASE_TONE[e.phase ?? 0] || "border-stone-300"} ${ring} ${fired ? "bg-emerald-50" : "bg-white"} px-3 py-2 ${fired || isSelected ? "" : "opacity-60"} flex flex-col overflow-hidden`}
                  style={{
                    left: `${pos.col * colPitch}px`,
                    top: `${laneTop[pos.lane]}px`,
                    width: `${cardW}px`,
                    height: `${cardHeightFor(e.ref)}px`,
                    backgroundImage: provHatch(provMode) || undefined,
                  }}
                >
                  <div className="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
                    <span className="truncate">
                      {i + 1}. {e.boundedContext}
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <ProvChip mode={provMode} />
                    </span>
                  </div>
                  <div className="text-[12px] font-medium leading-tight text-stone-800">{e.name}</div>
                  <div className="text-[10px] text-stone-500 mt-1">{e.role}</div>

                  {open && (
                    <div className="mt-1.5 pt-1.5 border-t border-stone-100 flex-1 min-h-0 overflow-y-auto text-[10px]">
                      {(firingsByRef.get(e.ref) || []).map((f, k) => {
                        const est = bizTimeEstimated(f)
                        const d = fmtBizDate(f.businessAt) ?? "—"
                        const g = prevIso && f.businessAt ? minutesBetween(prevIso, f.businessAt) : null
                        const ge = g != null && (est || prevEst)
                        if (f.businessAt) {
                          prevIso = f.businessAt
                          prevEst = est
                        }
                        const gt =
                          g != null && g >= LONG_GAP_MIN && !ge ? "text-amber-700 font-semibold" : "text-stone-500"
                        return (
                          <div key={k} className="flex items-baseline justify-between gap-1 leading-none py-0.5">
                            <span className="text-stone-700">
                              <span className="text-stone-400 tabular-nums mr-1">{k + 1}.</span>
                              {est ? (
                                <span className="mono italic text-stone-400" title={EST_TIME_TITLE}>
                                  ~{d}
                                </span>
                              ) : (
                                <span className="mono font-medium">{d}</span>
                              )}
                            </span>
                            {g != null && g > 0 && (
                              <span className={gt}>
                                {ge ? "~" : ""}
                                {fmtGap(g)}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {open && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation()
                        set({ splitRef: e.ref })
                      }}
                      title="Give each execution its own full box and branch downstream"
                      className="mt-1 shrink-0 w-full text-[9px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded px-1 py-0.5 leading-none"
                    >
                      ⑂ Split into {firedCounts.get(e.ref)} branches
                    </button>
                  )}

                  {!open && fired && (
                    <div className="mt-auto pt-1.5 border-t border-stone-100 flex items-baseline justify-between text-[10px]">
                      {bizLabel == null ? (
                        <span className="text-stone-700 font-medium mono">—</span>
                      ) : bz?.est ? (
                        <span className="text-stone-400 italic mono" title={EST_TIME_TITLE}>
                          ~{bizLabel}
                        </span>
                      ) : (
                        <span className="text-stone-700 font-medium mono">{bizLabel}</span>
                      )}
                      {gapMin != null && gapMin > 0 && (
                        <span className={gapTone}>
                          {gap?.est ? "~" : ""}
                          {fmtGap(gapMin)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {events.map((e, i) => {
              const pos = layout.place.get(e.ref) || { col: i, lane: 0, idx: i }
              return (
                <FiredCountBadge
                  key={e.ref}
                  n={firedCounts.get(e.ref) || 0}
                  cx={pos.col * colPitch + cardW}
                  cy={laneTop[pos.lane]!}
                  isOpen={isExpanded(e.ref)}
                  onToggle={() => toggleFirings(e.ref)}
                />
              )
            })}
          </div>

          <div className="h-1 bg-stone-200 rounded overflow-hidden mt-3" style={{ width: `${W}px` }}>
            <div className="h-1 bg-amber-400 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    </section>
  )
}
