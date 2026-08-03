import { useEffect } from "react"
import { api } from "../lib/api.ts"
import { useStore } from "../lib/store.ts"
import { attrText, genericColumns, prettyEntity } from "../lib/format.ts"
import { EST_TIME_TITLE, bizTimeEstimated, fmtBizDate, fmtGap, minutesBetween, timeAgo } from "../lib/time.ts"
import { computeFlowLayout, laneMetrics, FLOW } from "../lib/flowLayout.ts"
import { loadMeta, loadRegistryStatus } from "../lib/workflowData.ts"
import type { CaseRow, EventDef, FlowCaseRow, FlowRows } from "../lib/types.ts"
import { EventCard } from "../components/EventCard.tsx"
import { FlowEdges } from "../components/FlowEdges.tsx"
import { FlowCountBadge } from "../components/FlowCountBadge.tsx"
import { CopyCaseId } from "../components/CopyCaseId.tsx"
import { ViewSwitcher } from "../shell/ViewSwitcher.tsx"
import { AssistantButton } from "../shell/AssistantButton.tsx"

const POLL_MS = 5000
const LABEL_W = 210
const LONG_GAP_MIN = 10 * 1440

// Business-date footer per fired card, walking the events in declared order. A
// KNOWN date also shows the time since the case's previous KNOWN event; an
// estimated date renders greyed with a ~ and neither shows a gap nor becomes the
// next gap's baseline — a duration measured against an inferred moment is noise.
const rowFooters = (events: EventDef[], row: FlowCaseRow) => {
  const counts = row.counts || {}
  const times = row.times || {}
  const out = new Map<string, { label: string; est: boolean; gapMin: number | null }>()
  let prevKnownIso: string | null = null

  for (const e of events) {
    const t = (counts[e.ref] || 0) > 0 ? times[e.ref] : null
    const label = t ? fmtBizDate(t.businessAt) : null
    if (!label || !t) {
      continue
    }
    const est = bizTimeEstimated(t)
    let gapMin: number | null = null
    if (!est) {
      gapMin = prevKnownIso ? minutesBetween(prevKnownIso, t.businessAt) : null
      prevKnownIso = t.businessAt
    }
    out.set(e.ref, { label, est, gapMin })
  }
  return out
}

const CardFooter = ({ f }: { f: { label: string; est: boolean; gapMin: number | null } }) => {
  const tone = f.gapMin != null && f.gapMin >= LONG_GAP_MIN ? "text-amber-700 font-semibold" : "text-stone-500"
  return (
    <div className="mt-auto pt-1 border-t border-stone-100 flex items-baseline justify-between text-[10px]">
      {f.est ? (
        <span className="text-stone-400 italic mono" title={EST_TIME_TITLE}>
          ~{f.label}
        </span>
      ) : (
        <span className="text-stone-700 font-medium mono">{f.label}</span>
      )}
      {f.gapMin != null && f.gapMin > 0 && <span className={tone}>{fmtGap(f.gapMin)}</span>}
    </div>
  )
}

const loadFlowRows = async () => {
  const q = useStore.getState().flowRowsShowAll ? "?limit=0" : ""
  const [flowRows, events, cases] = await Promise.all([
    api<FlowRows>("/sim/flow-by-case" + q),
    api<EventDef[]>("/sim/events"),
    api<CaseRow[]>("/sim/cases"),
    loadRegistryStatus(),
    loadMeta(),
  ])
  useStore.getState().set({ flowRows, events, cases })
}

const Gutter = ({ row, attrKeys, caseRow }: { row: FlowCaseRow; attrKeys: string[]; caseRow: CaseRow | undefined }) => {
  const id = String(row.caseId)
  const start = row.startAt || row.lastAt
  const active = row.lastAt && row.lastAt !== start

  const lines = attrKeys.map((k) => ({ label: prettyEntity(k), value: attrText(caseRow?.[k]) }))

  return (
    <div
      className="group/case relative sticky left-0 z-20 bg-white group-hover:bg-stone-50 shrink-0 border-r border-stone-200 px-3 flex flex-col justify-center"
      style={{ width: `${LABEL_W}px` }}
    >
      <CopyCaseId id={id} />
      <div className="min-w-0 group-hover/case:pr-5 transition-[padding] duration-150">
        {lines.length > 0 ? (
          lines.map((l, i) =>
            i === 0 ? (
              <div key={l.label} className="text-[10px] font-semibold text-stone-800 truncate" title={`${l.label}: ${l.value}`}>
                {l.value}
              </div>
            ) : (
              <div key={l.label} className="text-[10px] text-stone-500 truncate" title={`${l.label}: ${l.value}`}>
                <span className="text-stone-400">{l.label}:</span> {l.value}
              </div>
            ),
          )
        ) : (
          <div className="text-[10px] font-semibold text-stone-800 truncate mono">{id.slice(0, 12)}…</div>
        )}
        {start && (
          <div className="text-[10px] text-stone-400 mt-1 leading-tight space-y-0.5">
            <div title={`Started ${new Date(start).toLocaleString()}`}>
              <span className="text-stone-400">Started</span>{" "}
              <span className="text-stone-600 font-medium">{timeAgo(start)}</span>
            </div>
            {active && (
              <div title={`Last activity ${new Date(row.lastAt!).toLocaleString()}`}>
                <span className="text-stone-400">Active</span>{" "}
                <span className="text-stone-600 font-medium">{timeAgo(row.lastAt)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const Rows = () => {
  const { flowRows, events, cases, meta, set } = useStore()

  useEffect(() => {
    loadFlowRows().catch(() => {})
    const t = setInterval(() => {
      if (!useStore.getState().busy) {
        loadFlowRows().catch(() => {})
      }
    }, POLL_MS)
    return () => clearInterval(t)
  }, [])

  const singular = prettyEntity(meta.rootAggregate)
  const rows = flowRows?.cases || []
  const layout = computeFlowLayout(events)
  const { laneTop, laneHeight, width: gridW, height: rowH } = laneMetrics(layout, FLOW)

  // Heat is comparable across rows: relative to the busiest single (case, step).
  let maxCount = 1
  for (const c of rows) {
    for (const ref in c.counts || {}) {
      maxCount = Math.max(maxCount, c.counts[ref]!)
    }
  }

  const caseById = new Map((cases || []).map((r) => [String(r.id), r]))
  let attrKeys = meta.rootMandatoryAttributes || []
  if (!attrKeys.length) {
    attrKeys = genericColumns(cases as Record<string, unknown>[])
  }
  attrKeys = attrKeys.slice(0, 3)

  const total = flowRows?.totalCases ?? rows.length
  const truncated = total > rows.length
  const anyEst = rows.some((c) => Object.values(c.times || {}).some((t) => bizTimeEstimated(t)))

  const showAll = () => {
    set({ flowRowsShowAll: true })
    loadFlowRows().catch(() => {})
  }

  return (
    <>
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="px-6 py-4 flex items-center gap-6">
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">
              {meta.title} — by case
            </div>
            <div className="text-stone-900 text-xl font-semibold leading-tight">
              Each {singular.toLowerCase()} as its own row
            </div>
          </div>
          <ViewSwitcher active="rows" />
          <AssistantButton />
        </div>
      </header>

      {rows.length === 0 ? (
        <section className="border-b border-stone-200 bg-stone-50 px-6 py-10 text-center text-sm text-stone-400">
          No cases have fired yet — run a case (or switch to{" "}
          <a href="#list" className="underline">
            List
          </a>
          ) to see it appear as a row here.
        </section>
      ) : (
        <section className="border-b border-stone-200 bg-white">
          <div className="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200">
            <span className="font-semibold text-stone-600">
              {rows.length}
              {truncated ? ` of ${total}` : ""} case{total === 1 ? "" : "s"}
            </span>
            <span className="text-stone-300">·</span>
            <span>one row per case, most recently active first</span>
            {anyEst && (
              <span className="flex items-center gap-1" title={EST_TIME_TITLE}>
                <span className="mono italic text-stone-400">~date</span> = estimated time
              </span>
            )}
            {truncated ? (
              <button
                type="button"
                onClick={showAll}
                title="Load every case (may be slow for very large workflows)"
                className="ml-auto italic text-amber-600 hover:text-amber-700 hover:underline cursor-pointer"
              >
                Showing the {rows.length} most recent of {total} — show all
              </button>
            ) : (
              <span className="ml-auto italic text-stone-400">Click a row to follow that case end to end</span>
            )}
          </div>

          <div className="overflow-x-auto">
            <div style={{ minWidth: `${LABEL_W + gridW}px` }}>
              {rows.map((c) => {
                const counts = c.counts || {}
                const firedRefs = new Set(events.filter((e) => (counts[e.ref] || 0) > 0).map((e) => e.ref))
                const footers = rowFooters(events, c)
                return (
                  <a
                    key={c.caseId}
                    href={`#case/${encodeURIComponent(String(c.caseId))}`}
                    className="flex items-stretch border-t border-stone-200 hover:bg-stone-50 group"
                  >
                    <Gutter row={c} attrKeys={attrKeys} caseRow={caseById.get(String(c.caseId))} />
                    <div className="relative shrink-0 my-2" style={{ width: `${gridW}px`, height: `${rowH}px` }}>
                      <FlowEdges
                        layout={layout}
                        laneTop={laneTop}
                        laneHeight={laneHeight}
                        geom={FLOW}
                        width={gridW}
                        height={rowH}
                        firedRefs={firedRefs}
                        markerId="rows-arrow"
                      />
                      {events.map((e, i) => {
                        const pos = layout.place.get(e.ref) || { col: i, lane: 0, idx: i }
                        const f = footers.get(e.ref)
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
                            footer={f && <CardFooter f={f} />}
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
                            title={`${e.name} fired ${n}× for this case`}
                          />
                        )
                      })}
                    </div>
                  </a>
                )
              })}
            </div>
          </div>
        </section>
      )}

      <main className="flex-1 overflow-auto p-6">
        <p className="text-sm text-stone-500 max-w-3xl">
          The merged flow split into one row per case — each row shows how far that {singular.toLowerCase()} got
          through the steps and which it triggered. Click a row to follow that case end to end, or switch to{" "}
          <a href="#flow" className="text-stone-800 underline">
            Workflow
          </a>{" "}
          for the combined view.
        </p>
      </main>
    </>
  )
}
