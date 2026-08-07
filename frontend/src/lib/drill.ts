// Drill-downs from the merged-flow overlays to a worklist. The contract: any
// card, pill, chip or matrix cell lands on a pre-filtered List in ≤2 clicks,
// sorted worst-first (stalest, least-progressed cases on top — the ones that
// need attention, not the ones that don't), with the whole slice in the URL
// hash so it can be pasted to a regional manager as a delegable link.
import { navigate } from "./router.ts"
import { TRIAGE_SORT, ov, patchOv, serializeOv } from "./ovquery.ts"
import type { OvFilter } from "./ovquery.ts"

export const drillToList = (filters: OvFilter[], opts?: { prog?: string }) => {
  const cur = ov()
  // Keep the user's current narrowing (an active region filter or progress chip
  // shaped the number they clicked, so it must carry into the worklist) but
  // replace any prior filter on the same fields; an explicit prog (the
  // "not started" drills) still overrides the chip.
  const drop = new Set(filters.map((f) => f.field))
  patchOv({
    filters: [...cur.filters.filter((f) => !drop.has(f.field)), ...filters],
    sort: TRIAGE_SORT.map((s) => ({ ...s })),
    prog: opts?.prog ?? cur.prog,
    tab: { ...cur.tab, list: { ...cur.tab.list, page: 0 } },
  })
  navigate("#list?" + serializeOv("list"))
}
