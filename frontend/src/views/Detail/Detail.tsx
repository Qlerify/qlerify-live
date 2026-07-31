import { useEffect } from "react"
import { useStore } from "../../lib/store.ts"
import { navigate, useRoute } from "../../lib/router.ts"
import { prettyEntity } from "../../lib/format.ts"
import { doNext, doReset, doRunAll, firedRefSet, loadDetail } from "../../lib/detailData.ts"
import { Pill } from "../../components/Pill.tsx"
import { Loading } from "../../components/Loading.tsx"
import { ViewSwitcher } from "../../shell/ViewSwitcher.tsx"
import { AssistantButton } from "../../shell/AssistantButton.tsx"
import { Timeline } from "./Timeline.tsx"
import { AsOfBanner } from "./AsOfBanner.tsx"
import { DataPanel } from "./DataPanel.tsx"

export const Detail = () => {
  const route = useRoute()
  const caseId = route.caseId || ""
  const { instance, events, log, meta, busy, currentIndex } = useStore()

  useEffect(() => {
    if (!caseId) {
      return
    }
    loadDetail(caseId).catch((e) => alert((e as Error).message))
  }, [caseId])

  if (!instance) {
    return <Loading />
  }

  const root = (instance.root || {}) as Record<string, unknown>
  const total = events.length
  const fired = firedRefSet(log).size
  const atEnd = currentIndex >= total

  return (
    <>
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => navigate("#")}
            title="Back to dashboard"
            className="p-1.5 -ml-1 rounded text-stone-500 hover:text-stone-900 hover:bg-stone-100"
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">
              {meta.title} · {root.id ? `${String(root.id).slice(0, 16)}…` : ""}
            </div>
            <div className="text-stone-900 text-xl font-semibold leading-tight flex items-center gap-2">
              {prettyEntity(meta.rootAggregate)}
              {root.status ? <Pill text={String(root.status)} status={String(root.status)} /> : null}
            </div>
          </div>
          <div className="text-sm text-stone-500 mr-2 tabular-nums">
            <span className="font-semibold text-stone-800">{fired}</span> / {total} fired
          </div>
          <button
            onClick={() => doReset(caseId, () => navigate("#"))}
            disabled={busy}
            className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50"
          >
            Reset
          </button>
          <button
            onClick={() => doNext(caseId)}
            disabled={busy || atEnd}
            className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium"
          >
            Step forward →
          </button>
          <button
            onClick={() => doRunAll(caseId)}
            disabled={busy || atEnd}
            className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50"
          >
            Run all
          </button>
          <ViewSwitcher active="" />
          <AssistantButton />
        </div>
      </header>

      <Timeline />
      <AsOfBanner />
      <DataPanel />
    </>
  )
}
