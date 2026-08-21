import { useEffect } from "react"
import { Loading } from "@/components/Loading.tsx"
import { Pill } from "@/components/Pill.tsx"
import { ProvChip } from "@/components/ProvChip.tsx"
import { AttrCell } from "@/components/AttrCell.tsx"
import { api } from "@/lib/api.ts"
import { navigate, parseHash } from "@/lib/router.ts"
import { useStore } from "@/lib/store.ts"
import { prettyEntity } from "@/lib/format.ts"
import { loadDashboard, pollOverview } from "@/lib/workflowData.ts"
import {
  applyQuery,
  caseRecords,
  colMeta,
  ensureOvScope,
  fmtStamp,
  hydrateOv,
  listColTokens,
  ovActive,
  pctOf,
  resetOvQuery,
  syncOvHash,
} from "@/lib/ovquery.ts"
import type { CaseRecord } from "@/lib/ovquery.ts"
import type { CaseRow } from "@/lib/types.ts"
import { OvToolbar } from "@/shell/Overview/OvToolbar.tsx"
import { OvPager } from "@/shell/Overview/OvPager.tsx"
import { SortableTh } from "@/shell/Overview/SortableTh.tsx"
import { ViewSwitcher } from "@/shell/ViewSwitcher.tsx"
import { AssistantButton } from "@/shell/AssistantButton.tsx"

const POLL_MS = 5000

const createCase = async () => {
  const { busy, set } = useStore.getState()
  if (busy) {
    return
  }
  set({ busy: true })
  try {
    const d = await api<{ id: string }>("/sim/cases", { method: "POST", body: "{}" })
    await loadDashboard()
    navigate(`#case/${encodeURIComponent(d.id)}`)
  } catch (e) {
    alert((e as Error).message)
  } finally {
    set({ busy: false })
  }
}

const deleteCase = async (caseId: string) => {
  if (!confirm("Remove this item and all its data?")) {
    return
  }
  const set = useStore.getState().set
  set({ busy: true })
  try {
    await api("/sim/delete", { method: "POST", body: JSON.stringify({ caseId }) })
    await loadDashboard()
  } catch (e) {
    alert("Delete failed: " + (e as Error).message)
  } finally {
    set({ busy: false })
  }
}

// The List's column plan: the chosen tokens with the mandatory Progress column
// pinned where it has always lived (before "last activity" when that column is
// on, else at the end). "$progress" is the pin — never choosable, always there.
const listColumnPlan = (records: CaseRecord[]) => {
  const toks = listColTokens(records)
  const before = toks.filter((t) => t !== "$lastEvent")
  return [...before, "$progress", ...(toks.includes("$lastEvent") ? ["$lastEvent"] : [])]
}

const Cell = ({ d, tok }: { d: CaseRow; tok: string }) => {
  if (tok === "$progress") {
    const pct = Math.round((d.progress / d.total) * 100) || 0
    return (
      <td className="px-4 py-3 w-56">
        <div className="flex items-center gap-2" title={`${pct}% — ${d.progress} of ${d.total} steps`}>
          <div className="flex-1 h-1.5 bg-stone-200 rounded overflow-hidden">
            <div className="h-1.5 bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-stone-500 tabular-nums w-12 text-right">
            {d.progress}/{d.total}
          </div>
        </div>
      </td>
    )
  }
  if (tok === "$status") {
    return <td className="px-4 py-3">{d.status ? <Pill text={d.status} status={d.status} /> : "—"}</td>
  }
  if (tok === "$createdAt" || tok === "$updatedAt") {
    const iso = (tok === "$createdAt" ? d.createdAt : d.updatedAt) as string | undefined
    return (
      <td
        className="px-4 py-3 text-xs text-stone-500 whitespace-nowrap"
        title={iso ? new Date(iso).toLocaleString() : undefined}
      >
        {fmtStamp(iso)}
      </td>
    )
  }
  if (tok === "$lastEvent") {
    return (
      <td className="px-4 py-3 text-xs">
        {d.lastEvent ? (
          <div className="text-stone-700 flex items-center gap-1.5">
            {d.lastEvent.eventName} <ProvChip mode={d.lastEvent.provenance} />
          </div>
        ) : (
          <span className="text-stone-400">no events yet</span>
        )}
      </td>
    )
  }
  return (
    <td className="px-4 py-3 text-sm text-stone-700">
      <AttrCell value={d[tok]} />
    </td>
  )
}

// A flow-row-only case (event-log caseId with no case row): renders as a
// visibly-uncorrelated line so drills that include orphans land on a list whose
// total matches the clicked count. No delete action — there is no row to reset.
const OrphanRow = ({ rec, plan }: { rec: CaseRecord; plan: string[] }) => (
  <tr
    className="cursor-pointer hover:bg-amber-50 transition-colors"
    onClick={() => navigate(`#case/${encodeURIComponent(rec.id)}`)}
  >
    <td className="px-4 py-3">
      <span className="inline-block w-2 h-2 rounded-full bg-rose-300" />
    </td>
    <td className="px-4 py-3 mono text-stone-500 text-xs" title={rec.id}>
      {rec.id.slice(0, 16)}…
    </td>
    <td className="px-4 py-3 text-xs text-stone-400 italic" colSpan={plan.length}>
      uncorrelated — event-log case with no case row · {pctOf(rec)}% of steps fired
    </td>
    <td className="px-4 py-3" />
  </tr>
)

const Row = ({ row, plan }: { row: CaseRow; plan: string[] }) => {
  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    deleteCase(row.id)
  }

  return (
    <tr
      className="cursor-pointer hover:bg-amber-50 transition-colors"
      onClick={() => navigate(`#case/${encodeURIComponent(row.id)}`)}
    >
      <td className="px-4 py-3">
        <span className="inline-block w-2 h-2 rounded-full bg-stone-300" />
      </td>
      <td className="px-4 py-3 mono text-stone-500 text-xs" title={row.id}>
        {row.id.slice(0, 16)}…
      </td>
      {plan.map((tok) => (
        <Cell key={tok} d={row} tok={tok} />
      ))}
      <td className="px-4 py-3 text-right">
        <button onClick={onDelete} title="Reset this run" className="text-stone-400 hover:text-rose-600 text-sm">
          ✕
        </button>
      </td>
    </tr>
  )
}

export const Dashboard = () => {
  const { events, meta, busy, ov, dashLoaded } = useStore()
  const plural = prettyEntity(meta.rootAggregatePlural)
  const singular = prettyEntity(meta.rootAggregate)

  useEffect(() => {
    ensureOvScope()
    hydrateOv("list", parseHash().ovqs || "")
    loadDashboard().catch(() => {})
    const t = setInterval(() => {
      pollOverview("dashboard").catch(() => {})
    }, POLL_MS)
    return () => clearInterval(t)
  }, [])

  // Unified records (case rows joined with flow rows) → the shared query engine:
  // filter → sort → the one page that actually renders. Row-less records
  // (uncorrelated event-log cases) stay IN: the flow view counts them in every
  // number it drills from, so the landed list must share the denominator.
  const records = caseRecords()
  const res = applyQuery(records, "list")
  const plan = listColumnPlan(records)
  const empty = records.length === 0
  const noMatch = !empty && res.total === 0

  // Keep the shareable slice in the URL without a reload.
  useEffect(() => {
    syncOvHash("list")
  }, [ov])

  if (!dashLoaded) {
    return <Loading />
  }

  return (
    <>
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="px-6 py-4 flex items-center gap-6">
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">
              {meta.title} — {plural}
            </div>
            <div className="text-stone-900 text-xl font-semibold leading-tight">
              All {plural.toLowerCase()} in flight
            </div>
          </div>
          <button
            onClick={createCase}
            disabled={busy}
            className="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium"
          >
            + New {singular.toLowerCase()}
          </button>
          <ViewSwitcher active="list" />
          <AssistantButton />
        </div>
      </header>

      {!empty && <OvToolbar tab="list" records={records} res={res} />}

      <main className="flex-1 overflow-auto p-6">
        {empty ? (
          <div className="max-w-md mx-auto mt-16 text-center">
            <div className="text-stone-400 text-5xl mb-3">∅</div>
            <div className="text-lg font-medium text-stone-700">No {plural.toLowerCase()} yet</div>
            <div className="text-sm text-stone-500 mt-1">
              Click <b>+ New {singular.toLowerCase()}</b> to start a fresh instance through the workflow.
            </div>
          </div>
        ) : noMatch ? (
          <div className="max-w-md mx-auto mt-16 text-center">
            <div className="text-stone-400 text-5xl mb-3">⌕</div>
            <div className="text-lg font-medium text-stone-700">No {plural.toLowerCase()} match</div>
            <div className="text-sm text-stone-500 mt-1">Nothing matches the current search and filters.</div>
            <button
              onClick={resetOvQuery}
              className="mt-4 px-4 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
            >
              Clear search &amp; filters
            </button>
          </div>
        ) : (
          <div className="rounded-lg border border-stone-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 border-b border-stone-200">
                <tr className="text-left text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-4 py-2 font-medium w-6" />
                  <SortableTh sortKey="id" label="id" />
                  {plan.map((tok) => {
                    const c = colMeta(tok)
                    return <SortableTh key={tok} sortKey={c.sort} label={c.label} />
                  })}
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {res.rows.map((rec) =>
                  rec.row ? <Row key={rec.id} row={rec.row} plan={plan} /> : <OrphanRow key={rec.id} rec={rec} plan={plan} />,
                )}
              </tbody>
            </table>
            <div className="px-4 py-2 border-t border-stone-200 bg-stone-50 flex items-center justify-between gap-4">
              <span className="text-xs text-stone-500">
                {ovActive() && (
                  <>
                    Filtered — <span className="tabular-nums">{res.total.toLocaleString()}</span> of{" "}
                    <span className="tabular-nums">{records.length.toLocaleString()}</span> {plural.toLowerCase()}
                  </>
                )}
              </span>
              <OvPager tab="list" res={res} />
            </div>
          </div>
        )}
      </main>

      <footer className="px-6 py-3 text-xs text-stone-500 border-t border-stone-200 bg-stone-50">
        <span>Generated from the live Qlerify model.</span>
        <span className="mx-2">·</span>
        <span>
          {events.length} events · {meta.boundedContextCount} systems · {meta.aggregateCount} aggregates
        </span>
      </footer>
    </>
  )
}
