import { parsePayload } from "./asOf.ts"
import type { FlowLayout } from "./flowLayout.ts"
import type { LogEntry, Row } from "./types.ts"

export type Firing = {
  i: number
  ref: string
  aggId: string
  payload: Row
  businessAt?: string | null
  col: number
  parentAggs: string[]
}

export type ForestNode = { f: Firing; children: ForestNode[]; row: number }

// Per-firing records for the case, oldest→newest, each tagged with its model
// column and its cross-aggregate FK parent id (a payload field, other than its
// own id, whose value is another firing's aggregateId).
export const caseFirings = (log: LogEntry[], layout: FlowLayout): Firing[] => {
  const chrono = log.slice().reverse()
  const firings: Firing[] = chrono.map((e, i) => ({
    i,
    ref: e.eventRef,
    aggId: e.aggregateId || "",
    payload: parsePayload(e.payload),
    businessAt: e.businessAt,
    col: layout.place.get(e.eventRef)?.col ?? 0,
    parentAggs: [],
  }))

  const aggIds = new Set(firings.map((f) => f.aggId).filter(Boolean))
  for (const f of firings) {
    // *Id-suffixed fields are listed first, but column proximity (in
    // buildBranchForest) decides which candidate actually becomes the parent.
    const seen = new Set<string>()
    const keys = Object.keys(f.payload)
      .filter((k) => k !== "id")
      .sort((a, b) => (b.endsWith("Id") ? 1 : 0) - (a.endsWith("Id") ? 1 : 0))
    for (const k of keys) {
      const v = f.payload[k]
      if (typeof v === "string" && v && v !== f.aggId && aggIds.has(v) && !seen.has(v)) {
        seen.add(v)
        f.parentAggs.push(v)
      }
    }
  }
  return firings
}

// Forest of instance nodes rooted at the firings of splitRef. A firing in the
// split subtree attaches to its own earlier firing on the same aggregate, else
// the firing that owns its nearest in-branch FK parent.
export const buildBranchForest = (splitRef: string, layout: FlowLayout, firings: Firing[]) => {
  const splitCol = layout.place.get(splitRef)?.col ?? 0
  const sub = firings.filter((f) => f.col >= splitCol)

  const firstByAgg = new Map<string, Firing>()
  for (const f of firings) {
    if (f.aggId && !firstByAgg.has(f.aggId)) {
      firstByAgg.set(f.aggId, f)
    }
  }
  const byAgg = new Map<string, Firing[]>()
  for (const f of sub) {
    if (!byAgg.has(f.aggId)) {
      byAgg.set(f.aggId, [])
    }
    byAgg.get(f.aggId)!.push(f)
  }
  for (const arr of byAgg.values()) {
    arr.sort((a, b) => a.col - b.col || a.i - b.i)
  }

  const nodeOf = new Map<Firing, ForestNode>(sub.map((f) => [f, { f, children: [], row: 0 }]))
  const roots: ForestNode[] = []

  for (const f of sub) {
    const node = nodeOf.get(f)!
    let parent: Firing | null = null
    const chain = byAgg.get(f.aggId)!
    const pos = chain.indexOf(f)
    if (pos > 0) {
      parent = chain[pos - 1]! // same entity, earlier step
    } else {
      // Cross-aggregate FK: the closest in-branch ancestor — the FK with the
      // highest column that is still an earlier step within the subtree.
      for (const agg of f.parentAggs) {
        const p = firstByAgg.get(agg)
        if (!p || p === f || p.col < splitCol || p.col >= f.col) {
          continue
        }
        if (!parent || p.col > parent.col) {
          parent = p
        }
      }
    }
    if (parent && nodeOf.has(parent) && parent !== f) {
      nodeOf.get(parent)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return { roots, splitCol }
}

// Assign a row to every node: leaves take successive rows, a parent centres on
// its children (sorted by business time so branches read top-down in order).
export const layoutForestRows = (roots: ForestNode[]): number => {
  const byTime = (a: ForestNode, b: ForestNode) =>
    (a.f.businessAt ? new Date(a.f.businessAt).getTime() : 0) - (b.f.businessAt ? new Date(b.f.businessAt).getTime() : 0)
  const sortKids = (n: ForestNode) => {
    n.children.sort(byTime)
    n.children.forEach(sortKids)
  }
  roots.sort(byTime)
  roots.forEach(sortKids)

  let r = 0
  const assign = (n: ForestNode) => {
    if (!n.children.length) {
      n.row = r++
      return
    }
    n.children.forEach(assign)
    n.row = (n.children[0]!.row + n.children[n.children.length - 1]!.row) / 2
  }
  roots.forEach(assign)
  return r
}
