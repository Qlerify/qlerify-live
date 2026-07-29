import { flowEdgePath } from "../lib/flowLayout.ts"
import type { FlowLayout, Geom } from "../lib/flowLayout.ts"

type Props = {
  layout: FlowLayout
  laneTop: number[]
  laneHeight: number[]
  geom: Geom
  width: number
  height: number
  firedRefs: Set<string>
  markerId: string
}

export const FlowEdges = ({ layout, laneTop, laneHeight, geom, width, height, firedRefs, markerId }: Props) => {
  if (!layout.edges.length) {
    return null
  }

  return (
    <svg width={width} height={height} className="absolute top-0 left-0" style={{ pointerEvents: "none" }}>
      <defs>
        <marker id={markerId} viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e" />
        </marker>
      </defs>
      {layout.edges.map(({ from, to }) => {
        const a = layout.place.get(from)
        const b = layout.place.get(to)
        if (!a || !b) {
          return null
        }
        const d = flowEdgePath(a, b, layout.waypoints.get(`${from}->${to}`), laneTop, laneHeight, geom)
        return (
          <path
            key={`${from}->${to}`}
            d={d}
            fill="none"
            stroke={firedRefs.has(to) ? "#78716c" : "#e7e5e4"}
            strokeWidth="2"
            markerEnd={`url(#${markerId})`}
          />
        )
      })}
    </svg>
  )
}
