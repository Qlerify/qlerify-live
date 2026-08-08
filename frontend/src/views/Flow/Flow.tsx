import { useEffect } from "react"
import { useStore } from "../../lib/store.ts"
import { prettyEntity } from "../../lib/format.ts"
import { loadFlow, pollOverview } from "../../lib/workflowData.ts"
import { parseHash } from "../../lib/router.ts"
import { applyQuery, caseRecords, ensureOvScope, hydrateOv, ovActive, progressCat, syncOvHash } from "../../lib/ovquery.ts"
import { cohortStats, periodCandidates, periodFromRecords } from "../../lib/cohort.ts"
import { OvToolbar } from "../../shell/Overview/OvToolbar.tsx"
import { ViewSwitcher } from "../../shell/ViewSwitcher.tsx"
import { AssistantButton } from "../../shell/AssistantButton.tsx"
import { FlowDiagram } from "./FlowDiagram.tsx"
import { SegmentStepMatrix } from "./SegmentStepMatrix.tsx"
import { BurnupStrip } from "./BurnupStrip.tsx"
import { TodoPanel } from "./TodoPanel.tsx"

const POLL_MS = 5000

export const Flow = () => {
  const { events, meta, ov } = useStore()
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

  // Search + filters narrow which cases feed EVERY merged counter — coverage
  // badges, pace bar, edge pills, anomaly chips, matrix and burn-ups all
  // recompute over the same slice (filtering to one region turns the whole view
  // into that region's funnel). The record set is EVERY case, so a match with no
  // events still counts in the denominator: coverage is honest about it.
  const flowRecords = caseRecords()
  const res = applyQuery(flowRecords, "flow")
  const stats = cohortStats(events, res.rows)
  const period = periodFromRecords(res.rows)
  const mixed = period ? [] : periodCandidates(res.rows)
  const filtered = ovActive() ? { matching: res.total, all: flowRecords.length } : null
  // Completion by the product's own rule (branch-aware), not "fired the last
  // declared event" — the two disagree on branched models.
  const doneCount = res.rows.filter((r) => progressCat(r) === "done").length

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

      <OvToolbar tab="flow" records={flowRecords} res={res} />

      <FlowDiagram
        events={events}
        meta={meta}
        stats={stats}
        period={period}
        mixed={mixed}
        filtered={filtered}
        done={doneCount}
      />

      <main className="flex-1 overflow-auto p-6 space-y-6">
        {period && <BurnupStrip records={res.rows} events={events} period={period} />}

        <TodoPanel records={res.rows} />

        <SegmentStepMatrix records={res.rows} events={events} />

        <p className="text-sm text-stone-500 max-w-3xl">
          Every case in this workflow, merged onto the model flow. Badges count the <b>distinct {plural.toLowerCase()}</b>{" "}
          through each step — the unit of a 100%-per-step goal — and deeper green means closer to full coverage; raw
          firing counts (incl. repeats) live in the tooltips. Click any number, pill or cell for its worklist. Switch to{" "}
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
