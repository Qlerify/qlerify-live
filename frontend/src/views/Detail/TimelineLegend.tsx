import { ProvChip } from "@/components/ProvChip.tsx"
import { useStore } from "@/lib/store.ts"
import { EST_TIME_TITLE, bizTimeEstimated } from "@/lib/time.ts"

const LastEvent = () => {
  const log = useStore((s) => s.log)

  if (!log.length) {
    return (
      <span className="ml-auto text-stone-400 italic">
        No events yet — press <b className="not-italic font-semibold">Step forward</b>
      </span>
    )
  }

  const last = log[0]!
  return (
    <span className="ml-auto flex items-center gap-1.5 min-w-0">
      <span className="uppercase tracking-widest text-stone-400 font-semibold">Last event</span>
      <span className="font-medium text-stone-800 truncate">{last.eventName}</span>
      <ProvChip mode={last.provenance} />
      <span className="text-stone-300">·</span>
      <span className="mono text-stone-500">{last.boundedContext}</span>
      <span className="text-stone-300">·</span>
      <span className="text-stone-500">{last.role}</span>
      <span className="text-stone-300">·</span>
      <span className="text-stone-400">{new Date(last.occurredAt).toLocaleTimeString()}</span>
    </span>
  )
}

// When any step's business time is an estimate, explain the ~date styling so a
// greyed timestamp is self-describing.
export const TimelineLegend = () => {
  const meta = useStore((s) => s.meta)
  const log = useStore((s) => s.log)
  const prov = meta.provenance
  const hasEst = (log || []).some((e) => bizTimeEstimated(e))

  return (
    <div className="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
      {prov?.steps && (
        <>
          <span className="font-semibold text-stone-600">
            {prov.steps.real} of {prov.steps.total} steps from a real source
          </span>
          <span className="flex items-center gap-1">
            <ProvChip mode="live" /> live
          </span>
          <span className="flex items-center gap-1">
            <ProvChip mode="recorded" /> recorded
          </span>
          <span className="flex items-center gap-1">
            <ProvChip mode="simulated" /> simulated
          </span>
        </>
      )}
      {hasEst && (
        <span className="flex items-center gap-1" title={EST_TIME_TITLE}>
          <span className="mono italic text-stone-400">~date</span> = estimated time
        </span>
      )}
      <LastEvent />
    </div>
  )
}
