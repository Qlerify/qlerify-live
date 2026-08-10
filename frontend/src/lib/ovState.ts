// Split out of ovquery.ts so the store can build its initial Overview state
// without importing the query engine, which imports the store back.
import { AUTH } from "./api.ts"

// "todo" is a paging-less tab like "flow": it shares search/filter/sort but
// keeps no page state of its own.
export type OvTab = "list" | "rows" | "flow" | "todo"
export type OvFilter = { field: string; op: string; value: string }
export type OvSort = { key: string; dir: 1 | -1 }
export type OvActivity = { field: "startedAt" | "lastAt"; within: string }

export type OvState = {
  wf: string
  q: string
  filters: OvFilter[]
  sort: OvSort[]
  prog: string
  activity: OvActivity
  tab: Record<"list" | "rows", { page: number; pageSize: number }>
  cols: string[] | null
}

// Per-tab page-size ladders: the List is a light table, but each By-case row is
// a full SVG flow grid (hundreds of nodes), so it caps low.
export const PAGE_SIZES: Record<string, number[]> = { list: [10, 25, 50, 100, 250], rows: [10, 25, 50] }
export const DEFAULT_PAGE_SIZE: Record<string, number> = { list: 25, rows: 10 }
export const pageSizesFor = (tab: string) => PAGE_SIZES[tab] || PAGE_SIZES.list!

const prefKey = (k: string) => `ql.ov.${AUTH.workflow() || "-"}.${k}`

export const pref = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(prefKey(k))
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export const setPref = (k: string, v: unknown) => {
  try {
    if (v == null) {
      localStorage.removeItem(prefKey(k))
    } else {
      localStorage.setItem(prefKey(k), JSON.stringify(v))
    }
  } catch {
    /* private mode etc. */
  }
}

export const normPageSize = (n: unknown, tab: string) => {
  const l = pageSizesFor(tab)
  return typeof n === "number" && l.includes(n) ? n : (DEFAULT_PAGE_SIZE[tab] ?? 25)
}

export const createOv = (): OvState => {
  const wf = AUTH.workflow() || "-"
  return {
    wf,
    q: "",
    filters: [],
    sort: [],
    prog: "",
    activity: { field: "lastAt", within: "" },
    tab: {
      list: { page: 0, pageSize: normPageSize(pref("list.pageSize", DEFAULT_PAGE_SIZE.list), "list") },
      rows: { page: 0, pageSize: normPageSize(pref("rows.pageSize", DEFAULT_PAGE_SIZE.rows), "rows") },
    },
    cols: pref<string[] | null>("cols", null),
  }
}
