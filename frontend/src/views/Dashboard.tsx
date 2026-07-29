import { useEffect } from "react"
import { api } from "../lib/api.ts"
import { navigate } from "../lib/router.ts"
import { useStore } from "../lib/store.ts"
import { genericColumns, prettyEntity } from "../lib/format.ts"
import { loadMeta, loadRegistryStatus } from "../lib/workflowData.ts"
import type { CaseRow, EventDef } from "../lib/types.ts"
import { Pill } from "../components/Pill.tsx"
import { ProvChip } from "../components/ProvChip.tsx"
import { AttrCell } from "../components/AttrCell.tsx"
import { ViewSwitcher } from "../shell/ViewSwitcher.tsx"

const POLL_MS = 5000

const loadDashboard = async () => {
  const set = useStore.getState().set
  const [cases, events] = await Promise.all([
    api<CaseRow[]>("/sim/cases"),
    api<EventDef[]>("/sim/events"),
    loadRegistryStatus(),
    loadMeta(),
  ])
  set({ cases, events })
}

const createCase = async () => {
  const { busy, set } = useStore.getState()
  if (busy) {
    return
  }
  set({ busy: true })
  try {
    const d = await api<{ id: string }>("/sim/cases", { method: "POST", body: "{}" })
    await loadDashboard()
    navigate(`#case/${d.id}`)
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

const Row = ({ row, cols }: { row: CaseRow; cols: string[] }) => {
  const pct = Math.round((row.progress / row.total) * 100) || 0

  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    deleteCase(row.id)
  }

  return (
    <tr className="cursor-pointer hover:bg-amber-50 transition-colors" onClick={() => navigate(`#case/${row.id}`)}>
      <td className="px-4 py-3">
        <span className="inline-block w-2 h-2 rounded-full bg-stone-300" />
      </td>
      <td className="px-4 py-3 mono text-stone-500 text-xs">{row.id.slice(0, 16)}…</td>
      {cols.map((c) => (
        <td key={c} className="px-4 py-3 text-sm text-stone-700">
          <AttrCell value={row[c]} />
        </td>
      ))}
      <td className="px-4 py-3">{row.status ? <Pill text={row.status} status={row.status} /> : "—"}</td>
      <td className="px-4 py-3 w-64">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-stone-200 rounded overflow-hidden">
            <div className="h-1.5 bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-stone-500 tabular-nums w-12 text-right">
            {row.progress}/{row.total}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-xs">
        {row.lastEvent ? (
          <div className="text-stone-700 flex items-center gap-1.5">
            {row.lastEvent.eventName} <ProvChip mode={row.lastEvent.provenance} />
          </div>
        ) : (
          <span className="text-stone-400">no events yet</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <button onClick={onDelete} title="Reset this run" className="text-stone-400 hover:text-rose-600 text-sm">
          ✕
        </button>
      </td>
    </tr>
  )
}

export const Dashboard = () => {
  const { cases, events, meta, busy } = useStore()
  const cols = genericColumns(cases as Record<string, unknown>[])
  const plural = prettyEntity(meta.rootAggregatePlural)
  const singular = prettyEntity(meta.rootAggregate)

  useEffect(() => {
    loadDashboard().catch(() => {})
    const t = setInterval(() => {
      if (!useStore.getState().busy) {
        loadDashboard().catch(() => {})
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
        </div>
      </header>

      <main className="flex-1 overflow-auto p-6">
        {cases.length === 0 ? (
          <div className="max-w-md mx-auto mt-16 text-center">
            <div className="text-stone-400 text-5xl mb-3">∅</div>
            <div className="text-lg font-medium text-stone-700">No {plural.toLowerCase()} yet</div>
            <div className="text-sm text-stone-500 mt-1">
              Click <b>+ New {singular.toLowerCase()}</b> to start a fresh instance through the workflow.
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-stone-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 border-b border-stone-200">
                <tr className="text-left text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-4 py-2 font-medium w-6" />
                  <th className="px-4 py-2 font-medium">id</th>
                  {cols.map((c) => (
                    <th key={c} className="px-4 py-2 font-medium">
                      {c}
                    </th>
                  ))}
                  <th className="px-4 py-2 font-medium">status</th>
                  <th className="px-4 py-2 font-medium">progress</th>
                  <th className="px-4 py-2 font-medium">last activity</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {cases.map((row) => (
                  <Row key={row.id} row={row} cols={cols} />
                ))}
              </tbody>
            </table>
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
