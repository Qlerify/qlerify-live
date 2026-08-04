import { EVIDENCE_KIND, EvidenceChip } from "../../components/EvidenceChip.tsx"
import { ProvChip } from "../../components/ProvChip.tsx"
import { EST_TIME_TITLE, bizTimeEstimated } from "../../lib/time.ts"
import { useStore } from "../../lib/store.ts"
import type { LogEntry } from "../../lib/types.ts"

// payload is JSON-serialized command args; pretty-print it, falling back to the
// raw string for legacy rows that aren't valid JSON.
const prettyPayload = (payload?: string) => {
  try {
    return JSON.stringify(JSON.parse(payload ?? "null"), null, 2)
  } catch {
    return String(payload ?? "")
  }
}

const LogRow = ({ e, index }: { e: LogEntry; index: number }) => {
  const payload = prettyPayload(e.payload)
  const hasPayload = payload && !["null", "{}", '""'].includes(payload)
  const biz = e.businessAt ? new Date(e.businessAt).toLocaleDateString() : null
  const km = e.evidenceKind ? EVIDENCE_KIND[e.evidenceKind] : undefined

  return (
    <details className="border-b border-stone-100">
      <summary className="px-4 py-2.5 cursor-pointer select-none hover:bg-stone-50">
        <span className="text-[11px] tabular-nums text-stone-400 mr-1">{index + 1}</span>
        <span className="font-medium text-stone-900">{e.eventName}</span> <ProvChip mode={e.provenance} />{" "}
        <EvidenceChip kind={e.evidenceKind} />
        <div className="text-xs text-stone-500 mt-0.5 ml-5">
          <span className="mono">{e.boundedContext}</span> · {e.role} · {new Date(e.occurredAt).toLocaleTimeString()}
          {biz && (
            <>
              {" · "}
              {bizTimeEstimated(e) ? (
                <span className="italic text-stone-400" title={EST_TIME_TITLE}>
                  ~{biz}
                </span>
              ) : (
                <span title="business date">{biz}</span>
              )}
            </>
          )}
        </div>
      </summary>
      <div className="px-4 pb-3 pl-9">
        {km ? (
          <div className="text-[11px] mb-2 rounded border border-stone-200 bg-white px-2 py-1.5">
            <div className="text-stone-700">
              <span className="mr-1">{km.icon}</span>
              <b>Why it fired:</b> {km.headline}
            </div>
            {e.evidence && <div className="text-stone-500 mono text-[10px] mt-0.5">{e.evidence}</div>}
          </div>
        ) : (
          <div className="text-[11px] text-stone-400 italic mb-2">
            No derivation evidence recorded — a simulator step, or derived before evidence was tracked (re-derive to
            populate).
          </div>
        )}
        {hasPayload ? (
          <pre className="mono text-[11px] whitespace-pre-wrap bg-stone-50 border border-stone-200 rounded p-2 text-stone-600">
            {payload}
          </pre>
        ) : (
          <div className="text-[11px] text-stone-400 italic">No payload</div>
        )}
        <div className="text-[10px] text-stone-400 mt-1 mono">
          {e.aggregateRoot || ""} · {e.aggregateId || ""}
        </div>
      </div>
    </details>
  )
}

// Every event this case has fired, oldest → newest (store.log is newest-first),
// reading top-down like the timeline reads left-to-right.
export const EventLogBody = () => {
  const log = useStore((s) => s.log)
  const ordered = (log || []).slice().reverse()

  if (ordered.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-6 text-sm text-stone-500">
        No events yet — press <b>Step forward</b> to advance this case through the workflow.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto text-sm">
      {ordered.map((e, i) => (
        <LogRow key={`${e.eventRef}-${i}`} e={e} index={i} />
      ))}
    </div>
  )
}
