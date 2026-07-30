import { caseFirings, buildBranchForest, layoutForestRows } from "../../lib/branchForest.ts"
import type { ForestNode } from "../../lib/branchForest.ts"
import { SPLIT_FLOW } from "../../lib/flowLayout.ts"
import type { FlowLayout } from "../../lib/flowLayout.ts"
import { fmtBizDate } from "../../lib/time.ts"
import { shortId } from "../../lib/asOf.ts"
import type { EventDef, LogEntry } from "../../lib/types.ts"
import { TimelineLegend } from "./TimelineLegend.tsx"

type Props = {
  events: EventDef[]
  log: LogEntry[]
  layout: FlowLayout
  splitRef: string
  firedCounts: Map<string, number>
  onMerge: () => void
}

export const SplitTimeline = ({ events, log, layout, splitRef, firedCounts, onMerge }: Props) => {
  const { cardW, cardH, colPitch, rowPitch } = SPLIT_FLOW
  const eventByRef = new Map(events.map((e) => [e.ref, e]))
  const splitEvent = eventByRef.get(splitRef)
  const splitName = splitEvent ? splitEvent.name : splitRef.split("/").pop()

  const firings = caseFirings(log, layout)
  const { roots, splitCol } = buildBranchForest(splitRef, layout, firings)
  const totalRows = Math.max(1, layoutForestRows(roots))

  const fnodes: ForestNode[] = []
  const fedges: [ForestNode, ForestNode][] = []
  const walk = (n: ForestNode) => {
    fnodes.push(n)
    for (const c of n.children) {
      fedges.push([n, c])
      walk(c)
    }
  }
  roots.forEach(walk)

  // Spine = events left of the split column, on one shared row pinned to the
  // top; the right-most spine event feeds every branch root.
  const spineRow = 0
  const spineEvents = events
    .filter((e) => (layout.place.get(e.ref)?.col ?? 0) < splitCol)
    .map((e) => ({ e, col: layout.place.get(e.ref)!.col }))
    .sort((a, b) => a.col - b.col)
  const feeder = spineEvents[spineEvents.length - 1] || null

  const maxCol = Math.max(splitCol, ...fnodes.map((n) => n.f.col), ...spineEvents.map((s) => s.col))
  const W = maxCol * colPitch + cardW
  const H = totalRows * rowPitch
  const xOf = (col: number) => col * colPitch
  const yOf = (row: number) => row * rowPitch + (rowPitch - cardH) / 2
  const rEdge = (col: number) => xOf(col) + cardW
  const midY = (row: number) => yOf(row) + cardH / 2

  const Curve = ({ sx, sy, ex, ey, stroke }: { sx: number; sy: number; ex: number; ey: number; stroke: string }) => {
    const dx = Math.max(20, (ex - sx) * 0.5)
    return (
      <path
        d={`M${sx},${sy} C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        markerEnd="url(#flow-arrow-split)"
      />
    )
  }

  return (
    <section className="border-b border-stone-200 bg-stone-50">
      <TimelineLegend />
      <div className="px-6 py-2 flex items-center gap-3 text-[11px] bg-emerald-50 border-b border-emerald-200">
        <span className="font-semibold text-emerald-800">
          ⑂ Branched by "{splitName}" — {roots.length} execution{roots.length === 1 ? "" : "s"}
        </span>
        <span className="text-stone-500">
          {fnodes.length} box{fnodes.length === 1 ? "" : "es"} · {totalRows} branch row{totalRows === 1 ? "" : "s"}
        </span>
        <button
          onClick={onMerge}
          className="ml-auto text-[11px] font-medium px-2.5 py-1 rounded-md border border-emerald-300 bg-white hover:bg-emerald-100 text-emerald-800"
        >
          ↩ Merge branches
        </button>
      </div>

      <div id="timeline-scroll" className="px-6 py-3 overflow-auto" style={{ maxHeight: "72vh" }}>
        <div className="relative" style={{ width: `${W}px`, height: `${H}px` }}>
          <svg width={W} height={H} className="absolute top-0 left-0" style={{ pointerEvents: "none" }}>
            <defs>
              <marker
                id="flow-arrow-split"
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
            {spineEvents.slice(1).map((s, k) => (
              <Curve
                key={`spine-${s.e.ref}`}
                sx={rEdge(spineEvents[k]!.col)}
                sy={midY(spineRow)}
                ex={xOf(s.col)}
                ey={midY(spineRow)}
                stroke="#78716c"
              />
            ))}
            {feeder &&
              roots.map((rt) => (
                <Curve
                  key={`root-${rt.f.i}`}
                  sx={rEdge(feeder.col)}
                  sy={midY(spineRow)}
                  ex={xOf(rt.f.col)}
                  ey={midY(rt.row)}
                  stroke="#34d399"
                />
              ))}
            {fedges.map(([p, c]) => (
              <Curve
                key={`edge-${p.f.i}-${c.f.i}`}
                sx={rEdge(p.f.col)}
                sy={midY(p.row)}
                ex={xOf(c.f.col)}
                ey={midY(c.row)}
                stroke="#34d399"
              />
            ))}
          </svg>

          {spineEvents.map(({ e, col }) => {
            const n = firedCounts.get(e.ref) || 0
            return (
              <div
                key={e.ref}
                className="absolute rounded-md border border-stone-300 bg-white px-2.5 py-1.5 flex flex-col overflow-hidden"
                style={{ left: `${xOf(col)}px`, top: `${yOf(spineRow)}px`, width: `${cardW}px`, height: `${cardH}px` }}
              >
                <div className="text-[9px] text-stone-500 truncate">{e.boundedContext}</div>
                <div className="text-[11px] font-semibold leading-tight text-stone-800 truncate">
                  {e.name}
                  {n > 1 && <span className="ml-1 text-emerald-700 font-bold">×{n}</span>}
                </div>
                <div className="mt-auto text-[9px] text-stone-400 truncate">{e.role || ""}</div>
              </div>
            )
          })}

          {fnodes.map((n) => {
            const f = n.f
            const ev = eventByRef.get(f.ref)
            const label = (f.payload.name as string) || (f.payload.title as string) || shortId(f.aggId)
            const date = fmtBizDate(f.businessAt) ?? "—"
            return (
              <div
                key={f.i}
                className="absolute rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 flex flex-col overflow-hidden shadow-sm"
                style={{ left: `${xOf(f.col)}px`, top: `${yOf(n.row)}px`, width: `${cardW}px`, height: `${cardH}px` }}
              >
                <div className="text-[9px] text-stone-500 truncate">{ev ? ev.name : f.ref.split("/").pop()}</div>
                <div
                  className="text-[11px] font-semibold leading-tight text-stone-800 truncate"
                  title={String(label)}
                >
                  {String(label)}
                </div>
                <div className="mt-auto text-[9px] text-stone-500 mono">{date}</div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
