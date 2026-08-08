import { useStore } from "../../lib/store.ts"
import { navigate } from "../../lib/router.ts"
import { ovQuerySuffix } from "../../lib/ovquery.ts"
import { PanelShell } from "../../components/PanelShell.tsx"
import type { CaseRecord } from "../../lib/ovquery.ts"

const TOP_N = 7

// The Flow tab's "top things to do now": the stalest unblocked steps across the
// CURRENT slice (an active filter narrows this panel like every other Flow
// counter). A summary, not the worklist — "See all" opens the To do tab with
// the same slice in the URL.
export const TodoPanel = ({ records }: { records: CaseRecord[] }) => {
  const nextActions = useStore((s) => s.nextActions)
  const recs = useStore((s) => s.recs)
  if (!nextActions) {
    return null
  }
  const inSlice = new Set(records.map((r) => r.id))
  const actions = nextActions.actions.filter((a) => inSlice.has(a.caseId))
  // A FRESH AI ranking reorders the panel (ranked first, deterministic rest);
  // a stale one is ignored rather than surfaced as if it were current. The
  // watermark equality guards the snapshot too: `status` was computed by the
  // server when recs was fetched, and events may have landed since.
  const fresh = recs?.status === "fresh" && recs.recs?.watermark === nextActions.watermark
  const rank = new Map(
    fresh ? (recs!.recs?.items ?? []).map((i) => [`${i.caseId}|${i.eventRef}`, i.priority]) : [],
  )
  const ordered = rank.size
    ? [...actions].sort(
        (a, b) =>
          (rank.get(`${a.caseId}|${a.eventRef}`) ?? Number.POSITIVE_INFINITY) -
          (rank.get(`${b.caseId}|${b.eventRef}`) ?? Number.POSITIVE_INFINITY),
      )
    : actions
  const top = ordered.slice(0, TOP_N)

  return (
    <PanelShell eyebrow="To do" title="Top things to do now">
      {top.length ? (
        <>
          <div className="-mx-4 divide-y divide-stone-100">
            {top.map((a) => (
              <button
                key={`${a.caseId}|${a.eventRef}`}
                onClick={() => navigate(`#case/${encodeURIComponent(a.caseId)}`)}
                title={a.why}
                className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50"
              >
                <span
                  className={`inline-block w-2 h-2 rounded-full shrink-0 ${a.stale ? "bg-amber-400" : "bg-emerald-400"}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-stone-800 truncate">
                    <span className="font-medium">{a.eventName}</span>
                    <span className="text-stone-400"> — {a.role}</span>
                  </div>
                  <div className="text-[11px] text-stone-500 truncate">
                    {a.caseId.slice(0, 20)}
                    {a.caseId.length > 20 ? "…" : ""}
                  </div>
                </div>
                {a.dwellDays != null && (
                  <span
                    className={`text-[11px] tabular-nums shrink-0 ${a.stale ? "text-amber-700 font-semibold" : "text-stone-400"}`}
                  >
                    {a.dwellDays}d
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="-mx-4 -mb-4 px-3 py-2 border-t border-stone-100">
            <a href={"#todo" + ovQuerySuffix()} className="text-[12px] text-stone-600 hover:text-stone-900 underline">
              See all {actions.length} → grouped by role
            </a>
          </div>
        </>
      ) : (
        <div className="text-sm text-stone-400">Nothing is waiting — every case in this slice is done.</div>
      )}
    </PanelShell>
  )
}
