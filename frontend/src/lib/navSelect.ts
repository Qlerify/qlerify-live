import { computeFlowLayout } from "./flowLayout.ts"
import type { EventDef } from "./types.ts"

export type Direction = "left" | "right" | "up" | "down"

// Move the selected event by the flow's 2-D layout (column/lane), not the
// linear sequence index. Left/right follow the current branch, bridging along
// a flow edge at a branch's start/end so leaving a sub-branch continues onto
// the main branch instead of dead-ending. Up/down cross to the parallel card
// stacked above/below at the same column. Returns the new index, or null if
// nothing moved.
export const navSelect = (events: EventDef[], selectedStep: number, dir: Direction): number | null => {
  const curRef = events[selectedStep]?.ref
  if (!curRef) {
    return null
  }
  const layout = computeFlowLayout(events)
  const cur = layout.place.get(curRef)
  if (!cur) {
    return null
  }

  const idxByRef = new Map(events.map((e, i) => [e.ref, i]))
  const cells: { idx: number; col: number; lane: number }[] = []
  events.forEach((e, idx) => {
    const p = layout.place.get(e.ref)
    if (p && e.ref !== curRef) {
      cells.push({ idx, col: p.col, lane: p.lane })
    }
  })

  let pick: { idx: number; col: number; lane: number } | null = null

  if (dir === "left" || dir === "right") {
    const cands = cells.filter((c) => c.lane === cur.lane && (dir === "right" ? c.col > cur.col : c.col < cur.col))
    for (const c of cands) {
      if (!pick || (dir === "right" ? c.col < pick.col : c.col > pick.col)) {
        pick = c
      }
    }
    if (!pick) {
      const linked =
        dir === "left"
          ? events[selectedStep]!.predecessors || []
          : events.filter((e) => (e.predecessors || []).includes(curRef)).map((e) => e.ref)
      for (const ref of linked) {
        const p = layout.place.get(ref)
        if (!p || (dir === "left" ? p.col >= cur.col : p.col <= cur.col)) {
          continue
        }
        const cand = { idx: idxByRef.get(ref)!, col: p.col, lane: p.lane }
        if (!pick || (dir === "left" ? p.col > pick.col : p.col < pick.col)) {
          pick = cand
        }
      }
    }
  } else {
    const cands = cells.filter((c) => c.col === cur.col && (dir === "up" ? c.lane < cur.lane : c.lane > cur.lane))
    for (const c of cands) {
      if (!pick || (dir === "up" ? c.lane > pick.lane : c.lane < pick.lane)) {
        pick = c
      }
    }
  }

  return pick ? pick.idx : null
}
