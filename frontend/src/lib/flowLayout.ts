import type { EventDef } from "./types.ts"

export type Placement = { col: number; lane: number; idx: number }
export type Edge = { from: string; to: string }
export type Waypoint = { lane: number; cols: number[] }

export type FlowLayout = {
  cols: number
  lanes: number
  place: Map<string, Placement>
  edges: Edge[]
  waypoints: Map<string, Waypoint>
}

export type Geom = { cardW: number; cardH: number; colPitch: number; rowPitch: number }

// Card + grid geometry (px). Cards are absolutely positioned so the connector SVG
// underneath can use exact coordinates.
export const FLOW: Geom = { cardW: 176, cardH: 104, colPitch: 224, rowPitch: 148 }

// Height of a row that carries a routed (skip) edge but no card.
export const ROUTE_ROW = 40

// Denser geometry for the branched (split) view.
export const SPLIT_FLOW: Geom = { cardW: 184, cardH: 72, colPitch: 212, rowPitch: 86 }

// Turn the event DAG into a 2-D placement: column = longest-path depth from a
// start event; lane = the longest path is the "spine" on lane 0, and every branch
// forking off it drops to the next free lane below.
export const computeFlowLayout = (events: EventDef[]): FlowLayout => {
  const byRef = new Map<string, { event: EventDef; idx: number }>()
  events.forEach((e, idx) => byRef.set(e.ref, { event: e, idx }))
  const preds = (ref: string) => (byRef.get(ref)?.event.predecessors || []).filter((p) => byRef.has(p))

  // No edges at all (linear model) → single lane in declared order.
  if (!events.some((e) => preds(e.ref).length > 0)) {
    const place = new Map(events.map((e, i) => [e.ref, { col: i, lane: 0, idx: i }]))
    return { cols: events.length, lanes: 1, place, edges: [], waypoints: new Map() }
  }

  const succ = new Map<string, string[]>(events.map((e) => [e.ref, []]))
  for (const e of events) {
    for (const p of preds(e.ref)) {
      succ.get(p)!.push(e.ref)
    }
  }

  const colMemo = new Map<string, number>()
  const col = (ref: string): number => {
    if (colMemo.has(ref)) {
      return colMemo.get(ref)!
    }
    const ps = preds(ref)
    const c = ps.length ? 1 + Math.max(...ps.map(col)) : 0
    colMemo.set(ref, c)
    return c
  }

  const hMemo = new Map<string, number>()
  const height = (ref: string): number => {
    if (hMemo.has(ref)) {
      return hMemo.get(ref)!
    }
    const ss = succ.get(ref) || []
    const h = ss.length ? 1 + Math.max(...ss.map(height)) : 0
    hMemo.set(ref, h)
    return h
  }

  events.forEach((e) => {
    col(e.ref)
    height(e.ref)
  })

  // Spine: start at the source beginning the longest path, then walk forward. At a
  // fork prefer a "shortcut" successor (an edge skipping columns) so the direct
  // line stays on top and the skipped sub-process drops below.
  const spine = new Set<string>()
  const sources = events.filter((e) => preds(e.ref).length === 0).map((e) => e.ref)
  if (sources.length) {
    let cur: string | undefined = sources.reduce((a, b) => (height(b) > height(a) ? b : a))
    while (cur) {
      spine.add(cur)
      const ss: string[] = succ.get(cur) || []
      if (!ss.length) {
        break
      }
      const cc = col(cur)
      const shortcuts: string[] = ss.filter((s: string) => col(s) - cc > 1)
      cur = shortcuts.length
        ? shortcuts.reduce((a: string, b: string) => (col(b) > col(a) ? b : a))
        : ss.reduce((a: string, b: string) => (height(b) > height(a) ? b : a))
    }
  }

  const lane = new Map<string, number>()
  const occupied = new Set<string>()
  for (const ref of spine) {
    lane.set(ref, 0)
    occupied.add(`0,${col(ref)}`)
  }

  // A branch is a weakly-connected group of non-spine events. Branches are placed
  // shortest-span first, so a small sub-branch claims the lane nearest the spine
  // and its connectors don't cross a longer one.
  const nonSpine = events.filter((e) => !spine.has(e.ref)).map((e) => e.ref)
  const adj = new Map<string, string[]>(nonSpine.map((r) => [r, []]))
  for (const r of nonSpine) {
    for (const p of preds(r)) {
      if (adj.has(p)) {
        adj.get(r)!.push(p)
        adj.get(p)!.push(r)
      }
    }
  }

  const seen = new Set<string>()
  const branches: { members: string[]; minCol: number; maxCol: number }[] = []
  for (const r of nonSpine) {
    if (seen.has(r)) {
      continue
    }
    const members: string[] = []
    const stack = [r]
    seen.add(r)
    while (stack.length) {
      const x = stack.pop()!
      members.push(x)
      for (const y of adj.get(x)!) {
        if (!seen.has(y)) {
          seen.add(y)
          stack.push(y)
        }
      }
    }
    const cs = members.map(col)
    branches.push({ members, minCol: Math.min(...cs), maxCol: Math.max(...cs) })
  }

  branches.sort(
    (a, b) =>
      a.maxCol - a.minCol - (b.maxCol - b.minCol) ||
      b.minCol - a.minCol ||
      byRef.get(a.members[0]!)!.idx - byRef.get(b.members[0]!)!.idx,
  )

  for (const br of branches) {
    const cs = br.members.map(col)
    let base = 1
    while (cs.some((c) => occupied.has(`${base},${c}`))) {
      base++
    }
    const ordered = br.members.slice().sort((a, b) => col(a) - col(b) || byRef.get(a)!.idx - byRef.get(b)!.idx)
    for (const ref of ordered) {
      const c = col(ref)
      let L = base
      while (occupied.has(`${L},${c}`)) {
        L++
      }
      lane.set(ref, L)
      occupied.add(`${L},${c}`)
    }
  }

  const place = new Map(
    events.map((e) => [e.ref, { col: col(e.ref), lane: lane.get(e.ref)!, idx: byRef.get(e.ref)!.idx }]),
  )
  const cols = Math.max(...events.map((e) => col(e.ref))) + 1
  const edges: Edge[] = []
  for (const e of events) {
    for (const p of preds(e.ref)) {
      edges.push({ from: p, to: e.ref })
    }
  }

  // Route long edges around the cards they fly over: give each a "waypoint row" —
  // the lowest lane free in every column it crosses — so it bows into its own row
  // instead of overlapping those cards.
  const waypoints = new Map<string, Waypoint>()
  let maxLane = events.reduce((m, e) => Math.max(m, lane.get(e.ref)!), 0)
  const longEdges = edges
    .map((e) => ({ ...e, c0: col(e.from), c1: col(e.to) }))
    .filter((e) => e.c1 - e.c0 > 1)
    .sort((a, b) => b.c1 - b.c0 - (a.c1 - a.c0))

  for (const e of longEdges) {
    const mid: number[] = []
    for (let c = e.c0 + 1; c < e.c1; c++) {
      mid.push(c)
    }
    // Both ends on the same clear lane → run dead straight, no routed row. This is
    // what keeps a spine shortcut a straight horizontal line.
    const lf = lane.get(e.from)!
    const lt = lane.get(e.to)!
    if (lf === lt && mid.every((c) => !occupied.has(`${lf},${c}`))) {
      mid.forEach((c) => occupied.add(`${lf},${c}`))
      continue
    }
    let L = 1
    while (!mid.every((c) => !occupied.has(`${L},${c}`))) {
      L++
    }
    mid.forEach((c) => occupied.add(`${L},${c}`))
    maxLane = Math.max(maxLane, L)
    waypoints.set(`${e.from}->${e.to}`, { lane: L, cols: mid })
  }

  return { cols, lanes: maxLane + 1, place, edges, waypoints }
}

// Connector path for one edge. Adjacent-column edges get a smooth S-curve; an edge
// with a waypoint row eases into it, runs flat, then climbs to the target.
export const flowEdgePath = (
  a: Placement,
  b: Placement,
  wp: Waypoint | undefined,
  laneTop: number[],
  laneHeight: number[],
  geom: Geom,
): string => {
  const { cardW, cardH, colPitch } = geom
  const sx = a.col * colPitch + cardW
  const sy = laneTop[a.lane]! + cardH / 2
  const ex = b.col * colPitch
  const ey = laneTop[b.lane]! + cardH / 2

  if (!wp) {
    const dx = Math.max(24, (ex - sx) * 0.5)
    return `M${sx},${sy} C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`
  }

  const ry = laneTop[wp.lane]! + laneHeight[wp.lane]! / 2
  const x1 = sx + 28
  const x2 = ex - 28
  const k = 36
  return `M${sx},${sy} C${sx + k},${sy} ${x1 - k},${ry} ${x1},${ry} L${x2},${ry} C${x2 + k},${ry} ${ex - k},${ey} ${ex},${ey}`
}

// Per-lane heights and offsets. Lanes carrying only a routed edge get a short row;
// card lanes keep the full card height.
export const laneMetrics = (layout: FlowLayout, geom: Geom) => {
  const laneGap = geom.rowPitch - geom.cardH
  const cardLanes = new Set(Array.from(layout.place.values(), (p) => p.lane))
  const laneHeight = Array.from({ length: layout.lanes }, (_, L) => (cardLanes.has(L) ? geom.cardH : ROUTE_ROW))
  const laneTop: number[] = []
  let acc = 0
  for (let L = 0; L < layout.lanes; L++) {
    laneTop[L] = acc
    acc += laneHeight[L]! + laneGap
  }
  const width = (layout.cols - 1) * geom.colPitch + geom.cardW
  const height = layout.lanes ? laneTop[layout.lanes - 1]! + laneHeight[layout.lanes - 1]! : geom.cardH
  return { laneTop, laneHeight, width, height }
}
