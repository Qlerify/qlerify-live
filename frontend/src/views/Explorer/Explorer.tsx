import { Fragment, useEffect, useRef, useState } from "react"
import { useRoute } from "@/lib/router.ts"
import { useStore } from "@/lib/store.ts"
import {
  adaptersForEntity,
  clearRows,
  expColumns,
  fetchRows,
  EXP_PAGE,
  runExpFilters,
  resetExpFilters,
  setExpPage,
  loadExplorer,
  selectEntity,
  selectSystem,
} from "@/lib/explorerData.ts"
import type { ColState } from "@/lib/explorerData.ts"
import { performsActions, pullLabel } from "@/lib/connectorBehavior.ts"
import { BehaviorBadge } from "@/views/Connectors/BehaviorBadge.tsx"
import { activateConnectorChat, openChat } from "@/lib/chatData.ts"
import type { ExpState, ExpSystem, ExpTable } from "@/lib/types.ts"
import { TableGlyph } from "./TableGlyph.tsx"
import { RowEventsCell } from "./RowEvents.tsx"
import { FiltersPanel } from "./FiltersPanel.tsx"
import { FieldValue } from "@/views/Detail/FieldValue.tsx"

// The `_raw` column holds the ingest fold of source fields the model doesn't
// declare — one JSON object per row. Parsed here so the cell can render as an
// expandable "N extra fields" toggle instead of a truncated JSON string.
const parseRawFold = (v: unknown): Record<string, unknown> | null => {
  if (typeof v !== "string" || !v) {
    return null
  }
  try {
    const p = JSON.parse(v)
    return p && typeof p === "object" && !Array.isArray(p) ? p : null
  } catch {
    return null
  }
}

const COL_STYLE: Record<ColState, { text: string; dot: string; title: string }> = {
  green: { text: "text-emerald-700", dot: "bg-emerald-500", title: "In the model and the data" },
  ghost: {
    text: "text-violet-600",
    dot: "bg-violet-400",
    title: "In the model but not in the data — the connector isn't populating this attribute",
  },
  amber: {
    text: "text-amber-700",
    dot: "bg-amber-500",
    title:
      "In the data but not in the model — either drift (a renamed/removed attribute) or a column you haven't modelled yet",
  },
  neutral: { text: "text-stone-500", dot: "bg-stone-300", title: "No model to compare against" },
}

// One render row per table, flagged with the first table of each system so the
// Systems column can print its name aligned to it. A table-less system still
// yields one row so both columns stay 1:1.
type Entry = { system: ExpSystem; table: ExpTable | null; first: boolean; sep: boolean }

const rowEntries = (e: ExpState): Entry[] => {
  const systems = e.health?.systems || []
  const entries: Entry[] = []
  let firstSystem = true
  for (const s of systems) {
    const sep = !firstSystem
    if (!s.tables.length) {
      entries.push({ system: s, table: null, first: true, sep })
      firstSystem = false
      continue
    }
    s.tables.forEach((t, i) => entries.push({ system: s, table: t, first: i === 0, sep: i === 0 && sep }))
    firstSystem = false
  }
  return entries
}

export const Explorer = () => {
  const route = useRoute()
  const { exp: e, chatOpen, set } = useStore()
  const sysBody = useRef<HTMLDivElement>(null)
  const tblBody = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)
  // Row id whose `_raw` extras panel is expanded (one at a time; a stale id
  // after paging/entity switches simply matches nothing).
  const [rawOpen, setRawOpen] = useState<string | null>(null)

  useEffect(() => {
    loadExplorer(route.expSys, route.expEntity).catch(() => {})
  }, [route.expSys, route.expEntity])

  // The builder conversation is per (system, table) — follow the selection.
  useEffect(() => {
    activateConnectorChat(e.system, e.entity)
  }, [e.system, e.entity])

  // Keep the Systems and Tables columns vertically aligned while scrolling.
  const linkScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => () => {
    if (syncing.current || !from || !to) {
      return
    }
    syncing.current = true
    to.scrollTop = from.scrollTop
    syncing.current = false
  }

  const entries = rowEntries(e)
  const tableCount = entries.filter((en) => en.table).length
  const entity = (e.entities || []).find((t) => t.name === e.entity) || (e.valueObjects || []).find((t) => t.name === e.entity)
  const cols = expColumns(e.items, entity)
  const hasModel = !!entity?.fields?.length
  const rows = e.items // already the current page window, filtered server-side
  const matched = e.matched ?? rows.length
  const total = e.total ?? matched
  // "120 of 1,234" when filters hide rows; just "1,234" otherwise.
  const countLabel = matched < total ? `${matched.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()
  const pages = Math.max(1, Math.ceil(matched / EXP_PAGE))
  const page = Math.min(e.page, pages - 1)
  const tableAdapters = adaptersForEntity(e)
  const runner = tableAdapters[0] ?? null
  const runLabel = runner ? pullLabel({ ...runner, boundedContext: runner.boundedContext || e.system || "the source" }) : "Fetch rows"
  const runActs = performsActions(runner)

  const clickTable = (systemName: string, tableName: string) => {
    if (systemName !== e.system) {
      selectSystem(systemName, tableName)
    } else {
      selectEntity(tableName)
    }
  }

  const toggleConnectorPanel = () => {
    if (chatOpen) {
      set({ chatOpen: false })
      return
    }
    set({ expPanelMode: "chat" })
    openChat()
  }

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden bg-stone-50">
      {e.sysCollapsed ? (
        <div className="w-9 shrink-0 border-r border-stone-200 bg-white flex flex-col items-center pt-3">
          <button
            onClick={() => set({ exp: { ...e, sysCollapsed: false } })}
            title="Show systems"
            className="text-stone-400 hover:text-stone-700"
          >
            ›
          </button>
        </div>
      ) : (
        <div className="w-56 shrink-0 border-r border-stone-200 bg-white flex flex-col">
          <div className="px-4 py-3 flex items-center justify-between border-b border-stone-100">
            <span className="font-semibold text-stone-900">Systems</span>
            <button
              onClick={() => set({ exp: { ...e, sysCollapsed: true } })}
              title="Collapse"
              className="text-stone-400 hover:text-stone-700"
            >
              ‹
            </button>
          </div>
          <div
            ref={sysBody}
            onScroll={linkScroll(sysBody.current, tblBody.current)}
            className="overflow-y-auto py-1 flex-1"
          >
            {!e.health ? (
              <div className="px-4 py-3 text-sm text-stone-400">Loading…</div>
            ) : entries.length === 0 ? (
              <div className="px-4 py-3 text-sm text-stone-400">No systems</div>
            ) : (
              entries.map((en, i) => {
                const active = en.system.name === e.system
                return (
                  <div
                    key={i}
                    className={`h-9 flex items-center px-4 ${en.sep ? "mt-2 border-t border-stone-200" : ""} ${en.first && active ? "bg-sky-50" : ""}`}
                  >
                    {en.first && (
                      <button
                        onClick={() => selectSystem(en.system.name)}
                        className={`text-sm text-left truncate ${active ? "text-sky-700 font-semibold" : "text-stone-700 hover:text-stone-900"}`}
                      >
                        {en.system.name}
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {e.tablesCollapsed ? (
        <div className="w-9 shrink-0 border-r border-stone-200 bg-white flex flex-col items-center pt-3">
          <button
            onClick={() => set({ exp: { ...e, tablesCollapsed: false } })}
            title="Show tables"
            className="text-stone-400 hover:text-stone-700"
          >
            ›
          </button>
        </div>
      ) : (
        <div className="w-80 shrink-0 border-r border-stone-200 bg-white flex flex-col">
          <div className="px-4 py-3 border-b border-stone-100 flex items-center justify-between">
            <span className="font-semibold text-stone-900">
              Tables <span className="text-stone-400 font-normal">({tableCount})</span>
            </span>
            <button
              onClick={() => set({ exp: { ...e, tablesCollapsed: true } })}
              title="Collapse"
              className="text-stone-400 hover:text-stone-700"
            >
              ‹
            </button>
          </div>
          <div
            ref={tblBody}
            onScroll={linkScroll(tblBody.current, sysBody.current)}
            className="overflow-y-auto py-1 flex-1"
          >
            {!e.health ? (
              <div className="px-4 py-3 text-sm text-stone-400">Loading…</div>
            ) : entries.length === 0 ? (
              <div className="px-4 py-3 text-sm text-stone-400">No tables</div>
            ) : (
              entries.map((en, i) => {
                const t = en.table
                if (!t) {
                  return <div key={i} className={`h-9 ${en.sep ? "mt-2 border-t border-stone-200" : ""}`} />
                }
                const sel = t.name === e.entity && en.system.name === e.system
                return (
                  <button
                    key={i}
                    onClick={() => clickTable(en.system.name, t.name)}
                    className={`w-full h-9 flex items-center gap-2 px-3 text-sm text-left hover:bg-stone-100 ${en.sep ? "mt-2 border-t border-stone-200" : ""} ${sel ? "bg-sky-50" : ""}`}
                  >
                    <TableGlyph kind={t.kind} status={t.status} />
                    <span className={`flex-1 truncate ${sel ? "text-sky-700 font-medium" : "text-stone-700"}`}>
                      {t.name}
                    </span>
                    {/* Only the acting ones are flagged here — this is a nav list, and
                        the badge is a warning rather than a label. Read off the health
                        payload, which spans every system: e.adapters holds only the
                        SELECTED one, so it would drop the badge on all the others. */}
                    {t.behavior === "actuator" && <BehaviorBadge behavior="actuator" />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}

      {!e.system ? (
        <div className="flex-1 flex items-center justify-center text-stone-400 text-sm">Loading systems…</div>
      ) : !e.entity ? (
        <div className="flex-1 flex items-center justify-center text-stone-400 text-sm">
          Select a table to explore its items.
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0 bg-white">
          <div className="px-6 py-4 flex items-center justify-between border-b border-stone-200">
            <div className="text-xl font-semibold text-stone-900">{e.entity}</div>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchRows}
                disabled={e.busy || !tableAdapters.length}
                title={
                  runner
                    ? runActs
                      ? `Run ${runner.id} — performs real actions in ${runner.boundedContext || e.system}`
                      : `Pull all rows from ${runner.id}`
                    : "No connector configured for this table"
                }
                className={`px-4 py-1.5 text-sm rounded-full border bg-white disabled:opacity-40 font-medium ${
                  runActs
                    ? "border-amber-400 text-amber-800 hover:bg-amber-50"
                    : "border-emerald-300 text-emerald-800 hover:bg-emerald-50"
                }`}
              >
                {runLabel}
              </button>
              <button
                onClick={clearRows}
                disabled={e.busy}
                title="Delete every row in this table and the simulated events derived from it (connectors are kept)"
                className="px-4 py-1.5 text-sm rounded-full border border-rose-300 bg-white text-rose-800 hover:bg-rose-50 disabled:opacity-40 font-medium"
              >
                Delete all rows
              </button>
              <button
                onClick={toggleConnectorPanel}
                className={`px-4 py-1.5 text-sm rounded-full border font-medium ${chatOpen ? "border-sky-400 bg-sky-50 text-sky-700" : "border-sky-300 bg-white text-sky-700 hover:bg-sky-50"}`}
              >
                Configure connector
              </button>
            </div>
          </div>

          <div className="px-6 py-3 border-b border-stone-200">
            <FiltersPanel filters={e.filters} columns={cols} onApply={runExpFilters} onReset={resetExpFilters} />
          </div>

          <div className="px-6 pt-3 pb-1 flex items-center justify-between">
            <div className="text-sm font-semibold text-stone-800">
              Table: {e.entity} — Items <span className="text-stone-400 font-normal">({countLabel})</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-stone-500">
              <button
                onClick={() => setExpPage(Math.max(0, page - 1))}
                className={`px-2 py-0.5 rounded hover:bg-stone-100 ${page <= 0 ? "opacity-40" : ""}`}
              >
                ‹
              </button>
              <span className="tabular-nums">
                {page + 1} / {pages}
              </span>
              <button
                onClick={() => setExpPage(Math.min(pages - 1, page + 1))}
                className={`px-2 py-0.5 rounded hover:bg-stone-100 ${page >= pages - 1 ? "opacity-40" : ""}`}
              >
                ›
              </button>
            </div>
          </div>

          {hasModel && (
            <div className="px-6 pb-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-stone-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                In model &amp; data
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-400" />
                In model, no data <span className="italic">(not populated)</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
                In data, not in model <span className="italic">(stale / unmodelled)</span>
              </span>
            </div>
          )}

          <div className="flex-1 overflow-auto px-6 pb-6">
            {e.busy ? (
              <div className="text-stone-400 text-sm py-10 text-center">Loading…</div>
            ) : e.tableMissing ? (
              <div className="text-stone-400 text-sm py-10 text-center">
                No data yet for <b>{e.entity}</b>. Run the simulator or configure a connector to populate it.
              </div>
            ) : rows.length === 0 ? (
              <div className="text-stone-400 text-sm py-10 text-center">No items match the filters.</div>
            ) : (
              <div className="rounded-lg border border-stone-200 overflow-x-auto">
                <table className="min-w-full">
                  <thead className="bg-stone-50">
                    <tr>
                      <th className="px-3 py-2 w-8 border-b border-stone-200" />
                      {cols.map((c) => {
                        const st = COL_STYLE[c.state]
                        return (
                          <th
                            key={c.name}
                            title={st.title}
                            className={`px-3 py-2 text-left text-[11px] font-semibold ${st.text} whitespace-nowrap border-b border-stone-200`}
                          >
                            <span className="inline-flex items-center gap-1.5">
                              <span className={`inline-block w-1.5 h-1.5 rounded-full ${st.dot}`} />
                              {c.name}
                            </span>
                          </th>
                        )
                      })}
                      <th className="px-3 py-2 text-left text-[11px] font-semibold text-stone-600 whitespace-nowrap border-b border-stone-200 border-l border-stone-100">
                        ⚡ Events
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, ri) => {
                      const rid = String(r.id ?? ri)
                      const rawObj = parseRawFold(r._raw)
                      const rawOpened = rawOpen === rid && !!rawObj
                      return (
                        <Fragment key={rid}>
                          <tr className="hover:bg-stone-50 border-b border-stone-100">
                            <td className="px-3 py-2 align-top">
                              <input type="checkbox" className="rounded border-stone-300" />
                            </td>
                            {cols.map((col, ci) => {
                              const val = r[col.name]
                              const empty = val === null || val === undefined || val === ""
                              const s = empty ? "" : String(val)
                              if (col.name === "_raw" && rawObj) {
                                const n = Object.keys(rawObj).length
                                return (
                                  <td key={col.name} className="px-3 py-2 text-sm whitespace-nowrap align-top">
                                    <button
                                      type="button"
                                      aria-expanded={rawOpened}
                                      onClick={() => setRawOpen(rawOpened ? null : rid)}
                                      className="text-xs text-amber-700 hover:text-amber-900 underline decoration-dotted"
                                    >
                                      {n} extra field{n === 1 ? "" : "s"} {rawOpened ? "▴" : "▾"}
                                    </button>
                                  </td>
                                )
                              }
                              return (
                                <td
                                  key={col.name}
                                  className={`px-3 py-2 text-sm whitespace-nowrap align-top ${ci === 0 ? "text-sky-700 font-medium mono text-xs" : "text-stone-700"}`}
                                >
                                  {empty ? (
                                    <span className="text-stone-300">—</span>
                                  ) : s.length > 44 ? (
                                    s.slice(0, 44) + "…"
                                  ) : (
                                    s
                                  )}
                                </td>
                              )
                            })}
                            <RowEventsCell events={e.rowEvents[String(r.id)]} busy={e.rowEventsBusy} />
                          </tr>
                          {rawOpened && rawObj && (
                            <tr className="border-b border-stone-100 bg-amber-50/40">
                              <td />
                              <td colSpan={cols.length + 1} className="px-3 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-amber-700 mb-1.5">
                                  Extra source fields — preserved in _raw, not in the model
                                </div>
                                <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-4 gap-y-1 max-w-4xl">
                                  {Object.entries(rawObj).map(([k, v]) => (
                                    <Fragment key={k}>
                                      <div className="mono text-[11px] text-amber-800 break-words">{k}</div>
                                      <div className="text-xs text-stone-700 min-w-0">
                                        <FieldValue name={k} value={v} />
                                      </div>
                                    </Fragment>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
