import { useEffect } from "react"
import { useStore } from "../../lib/store.ts"
import { prettyEntity } from "../../lib/format.ts"
import { loadFlow, pollOverview } from "../../lib/workflowData.ts"
import { parseHash } from "../../lib/router.ts"
import { caseRecords, ensureOvScope, flowSlice, hydrateOv, syncOvHash } from "../../lib/ovquery.ts"
import { OvToolbar } from "../../shell/Overview/OvToolbar.tsx"
import { ViewSwitcher } from "../../shell/ViewSwitcher.tsx"
import { AssistantButton } from "../../shell/AssistantButton.tsx"
import { FlowDiagram } from "./FlowDiagram.tsx"

const POLL_MS = 5000

export const Flow = () => {
  const { flow, events, meta, ov } = useStore()
  const plural = prettyEntity(meta.rootAggregatePlural)

  useEffect(() => {
    ensureOvScope()
    hydrateOv("flow", parseHash().ovqs || "")
    loadFlow().catch(() => {})
    const t = setInterval(() => {
      pollOverview("flow").catch(() => {})
    }, POLL_MS)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    syncOvHash("flow")
  }, [ov])

  // Search + filters narrow which cases feed the merged counters. Sorting and
  // paging don't apply to a merged diagram, so the toolbar omits them here. The
  // record set is EVERY case (matching the flowSlice denominator), not only
  // those with events, so the toolbar's "N of M" agrees with the banner.
  const flowRecords = caseRecords()
  const slice = flowSlice()

  return (
    <>
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="px-6 py-4 flex items-center gap-6">
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">
              {meta.title} — merged flow
            </div>
            <div className="text-stone-900 text-xl font-semibold leading-tight">
              All {plural.toLowerCase()} on one flow
            </div>
          </div>
          <ViewSwitcher active="flow" />
          <AssistantButton />
        </div>
      </header>

      <OvToolbar
        tab="flow"
        records={flowRecords}
        res={{ total: slice ? slice.totalCases : flowRecords.length, rows: [], page: 0, pages: 1, from: 0, to: 0 }}
      />

      <FlowDiagram events={events} flow={flow} meta={meta} slice={slice} />

      <main className="flex-1 overflow-auto p-6">
        <p className="text-sm text-stone-500 max-w-3xl">
          Every case in this workflow, merged onto the model flow. The ×N badge on an event counts how many times it
          triggered across all {plural.toLowerCase()}; brighter cards are busier steps. Switch to{" "}
          <a href="#rows" className="text-stone-800 underline">
            By case
          </a>{" "}
          to split it into one row per case, or{" "}
          <a href="#list" className="text-stone-800 underline">
            List
          </a>{" "}
          to follow a single case end to end.
        </p>
      </main>
    </>
  )
}
