import { useEffect } from "react"
import { Pill } from "@/components/Pill.tsx"
import { Loading } from "@/components/Loading.tsx"
import { useStore } from "@/lib/store.ts"
import { navigate, useRoute } from "@/lib/router.ts"
import { prettyEntity } from "@/lib/format.ts"
import { doNext, doReset, doRunAll, firedRefSet, loadDetail } from "@/lib/detailData.ts"
import { ViewSwitcher } from "@/shell/ViewSwitcher.tsx"
import { AssistantButton } from "@/shell/AssistantButton.tsx"
import { Timeline } from "./Timeline.tsx"
import { AsOfBanner } from "./AsOfBanner.tsx"
import { DataPanel } from "./DataPanel.tsx"

export const Detail = () => {
  const route = useRoute()
  const caseId = route.caseId || ""
  const { instance, events, log, meta, busy, currentIndex, caseNextActions, recs } = useStore()

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

  // The frontier ("what can happen next"), not the simulator's linear cursor —
  // on a branched model several steps can be open at once, and a skipped step
  // never lingers here. The Step buttons keep the linear cursor by design.
  const next = caseNextActions || []
  const nextShown = next.slice(0, 3)
  const nextTitle = next.map((a) => `${a.eventName} (${a.role}) — ${a.why}`).join("\n")

  // The AI's top-ranked open step for THIS case — only when the stored ranking
  // still matches the current model + data (stale advice is worse than none).
  const rec =
    recs?.status === "fresh"
      ? (recs.recs?.items.find((i) => i.caseId === caseId && next.some((a) => a.eventRef === i.eventRef)) ?? null)
      : null
  const recEvent = rec ? events.find((e) => e.ref === rec.eventRef) : null

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
            {caseNextActions != null && (
              <div className="text-[12px] mt-0.5 truncate" title={nextTitle || undefined}>
                {next.length ? (
                  <>
                    <span className="uppercase tracking-widest text-stone-400 font-semibold text-[10px] mr-1.5">
                      Next
                    </span>
                    {nextShown.map((a, i) => (
                      <span key={a.eventRef} className="text-stone-700">
                        {i > 0 && <span className="text-stone-300"> · </span>}
                        <b className="font-medium">{a.eventName}</b>
                        <span className="text-stone-500"> ({a.role})</span>
                      </span>
                    ))}
                    {next.length > nextShown.length && (
                      <span className="text-stone-400"> · +{next.length - nextShown.length} more</span>
                    )}
                    <a href="#todo" className="ml-2 text-stone-400 hover:text-stone-700 underline">
                      to do
                    </a>
                  </>
                ) : (
                  <span className="text-stone-400">
                    {fired === 0 ? "Not started — no events yet" : "No open next step — this path is complete"}
                  </span>
                )}
              </div>
            )}
            {rec && recEvent && (
              <div
                className="text-[12px] mt-0.5 truncate"
                title={`AI-recommended next action (ranked #${rec.priority} across the whole workflow): ${rec.why}`}
              >
                <span className="text-[10px] px-1 py-px rounded bg-stone-900 text-white font-semibold mr-1.5">AI</span>
                <span className="uppercase tracking-widest text-stone-400 font-semibold text-[10px] mr-1.5">
                  Recommended
                </span>
                <b className="font-medium text-stone-700">{recEvent.name}</b>
                <span className="text-stone-500"> — {rec.why}</span>
              </div>
            )}
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
