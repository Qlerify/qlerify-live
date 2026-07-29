import { useEffect } from "react"
import { api } from "../../lib/api.ts"
import { useStore } from "../../lib/store.ts"
import { prettyEntity } from "../../lib/format.ts"
import { loadMeta, loadRegistryStatus } from "../../lib/workflowData.ts"
import type { EventDef, FlowAggregate } from "../../lib/types.ts"
import { ViewSwitcher } from "../../shell/ViewSwitcher.tsx"
import { FlowDiagram } from "./FlowDiagram.tsx"

const POLL_MS = 5000

const loadFlow = async () => {
  const [flow, events] = await Promise.all([
    api<FlowAggregate>("/sim/flow-aggregate"),
    api<EventDef[]>("/sim/events"),
    loadRegistryStatus(),
    loadMeta(),
  ])
  useStore.getState().set({ flow, events })
}

export const Flow = () => {
  const { flow, events, meta } = useStore()
  const plural = prettyEntity(meta.rootAggregatePlural)

  useEffect(() => {
    loadFlow().catch(() => {})
    const t = setInterval(() => {
      if (!useStore.getState().busy) {
        loadFlow().catch(() => {})
      }
    }, POLL_MS)
    return () => clearInterval(t)
  }, [])

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
        </div>
      </header>

      <FlowDiagram events={events} flow={flow} meta={meta} />

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
