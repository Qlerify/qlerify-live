import { useEffect, useRef, useState } from "react"
import { useStore } from "@/lib/store.ts"
import { prettyEntity } from "@/lib/format.ts"
import {
  ACTIVITY_WINDOWS,
  OPS,
  PROG_LABEL,
  SYS_COL_TOKENS,
  activityLabel,
  attrColumns,
  attrFieldKeys,
  colMeta,
  cycleSort,
  defaultOp,
  ensureFields,
  fieldDef,
  filterFieldGroups,
  flipSort,
  listColTokens,
  opLabel,
  ov,
  ovActive,
  patchOv,
  removeSort,
  resetOvQuery,
  setOvCols,
  sortMenuFields,
  toggleOvCol,
} from "@/lib/ovquery.ts"
import type { CaseRecord, OvFilter, OvTab, QueryResult } from "@/lib/ovquery.ts"
import { Dropdown } from "./Dropdown.tsx"

const SELECT = "text-sm border border-stone-300 rounded-md px-2 py-1.5 bg-white"
const BTN2 = "px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
const CHIP = "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 text-xs"

const Segmented = ({
  options,
  value,
  onPick,
}: {
  options: [string, string, string][]
  value: string
  onPick: (v: string) => void
}) => (
  <div
    className="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-stone-300 bg-stone-100 text-xs"
    role="group"
  >
    {options.map(([val, label, title]) => (
      <button
        key={val}
        type="button"
        title={title}
        onClick={() => onPick(val)}
        className={`px-2.5 py-1 rounded whitespace-nowrap transition-colors ${value === val ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"}`}
      >
        {label}
      </button>
    ))}
  </div>
)

const FilterRow = ({ f, onChange, onRemove }: { f: OvFilter; onChange: (f: OvFilter) => void; onRemove: () => void }) => {
  const def = fieldDef(f.field)
  const type = def?.type || "string"
  const inputType = type === "number" ? "number" : type === "date" ? "date" : "text"
  const valRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex items-center gap-2">
      <select
        value={f.field}
        aria-label="Filter field"
        onChange={(e) => {
          const nextType = fieldDef(e.target.value)?.type || "string"
          onChange({ field: e.target.value, op: defaultOp(nextType), value: "" })
          setTimeout(() => valRef.current?.focus(), 30)
        }}
        className={`${SELECT} max-w-[180px]`}
      >
        {filterFieldGroups().map(([label, keys]) => {
          const opts = keys.filter((k) => fieldDef(k))
          if (!opts.length) {
            return null
          }
          return (
            <optgroup key={label} label={label}>
              {opts.map((k) => (
                <option key={k} value={k}>
                  {fieldDef(k)!.label}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
      <select
        value={f.op}
        aria-label="Filter condition"
        onChange={(e) => onChange({ ...f, op: e.target.value })}
        className={SELECT}
      >
        {(OPS[type] || []).map(([op, label]) => (
          <option key={op} value={op}>
            {label}
          </option>
        ))}
      </select>
      <input
        ref={valRef}
        type={inputType}
        step={inputType === "number" ? "any" : undefined}
        value={f.value ?? ""}
        placeholder="value"
        aria-label="Filter value"
        onChange={(e) => onChange({ ...f, value: e.target.value })}
        className="flex-1 min-w-0 text-sm border border-stone-300 rounded-md px-2 py-1.5"
      />
      <button type="button" onClick={onRemove} title="Remove this filter" className="p-1 text-stone-400 hover:text-rose-600">
        ✕
      </button>
    </div>
  )
}

type Menu = "filters" | "sort" | "cols" | "activity" | null

export const OvToolbar = ({ tab, records, res }: { tab: OvTab; records: CaseRecord[]; res?: QueryResult }) => {
  const o = useStore((s) => s.ov)
  const meta = useStore((s) => s.meta)
  const [menu, setMenu] = useState<Menu>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Typing shouldn't re-run the query on every keystroke.
  const [draft, setDraft] = useState(o.q)

  ensureFields(records)

  useEffect(() => {
    setDraft(o.q)
  }, [o.q])

  useEffect(() => {
    const t = setTimeout(() => {
      if (draft !== ov().q) {
        patchOv({ q: draft, tab: { ...ov().tab, list: { ...ov().tab.list, page: 0 }, rows: { ...ov().tab.rows, page: 0 } } })
      }
    }, 180)
    return () => clearTimeout(t)
  }, [draft])

  // "/" focuses search anywhere on an Overview tab; Escape clears and blurs.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
      if (ev.key === "/" && !typing) {
        ev.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (ev.key === "Escape" && el === searchRef.current) {
        setDraft("")
        patchOv({ q: "" })
        searchRef.current?.blur()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const activeFilters = o.filters.filter((f) => String(f.value ?? "") !== "").length
  const anyState = ovActive() || o.sort.length > 0
  const singular = prettyEntity(meta.rootAggregate || "case").toLowerCase()
  const plural = prettyEntity(meta.rootAggregatePlural || "cases").toLowerCase()

  const setFilter = (i: number, next: OvFilter) => {
    patchOv({ filters: o.filters.map((f, k) => (k === i ? next : f)) })
  }

  return (
    <div className="px-6 py-2.5 bg-white border-b border-stone-200 flex flex-wrap items-center gap-2">
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 text-sm pointer-events-none">⌕</span>
        <input
          ref={searchRef}
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Search ${plural}…  ( / )`}
          autoComplete="off"
          spellCheck={false}
          aria-label="Free-text search across every attribute"
          className="w-64 text-sm border border-stone-300 rounded-md pl-8 pr-7 py-1.5 focus:border-amber-400 focus:outline-none"
        />
        {draft && (
          <button
            type="button"
            onClick={() => {
              setDraft("")
              patchOv({ q: "" })
            }}
            title="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"
          >
            ✕
          </button>
        )}
      </div>

      <Segmented
        value={o.prog}
        onPick={(prog) => patchOv({ prog })}
        options={[
          ["", "All", "Every case"],
          ["none", "Not started", "Cases with no fired steps yet"],
          ["active", "In progress", "Cases somewhere mid-flow"],
          ["done", "Done", "Cases that completed their branch"],
        ]}
      />

      <Dropdown
        label={o.activity.within ? activityLabel(o.activity) : "Activity"}
        active={!!o.activity.within}
        open={menu === "activity"}
        onToggle={(v) => setMenu(v ? "activity" : null)}
        width="w-60"
      >
        <div className="p-2 space-y-1">
          <div className="px-1 pb-0.5 text-[11px] text-stone-400">Show {singular}s by when they were…</div>
          <Segmented
            value={o.activity.field}
            onPick={(field) => patchOv({ activity: { ...o.activity, field: field as "startedAt" | "lastAt" } })}
            options={[
              ["startedAt", "Started", "The case's first (business) event date"],
              ["lastAt", "Active", "The case's most recent (business) activity"],
            ]}
          />
          <div className="pt-1">
            {[["", "Any time"] as [string, string], ...ACTIVITY_WINDOWS].map(([v, l]) => (
              <button
                key={v}
                type="button"
                onClick={() => patchOv({ activity: { ...o.activity, within: v } })}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-sm ${o.activity.within === v ? "bg-amber-50 text-stone-900" : "hover:bg-stone-50 text-stone-700"}`}
              >
                <span className="w-3 text-amber-600">{o.activity.within === v ? "✓" : ""}</span>
                {l}
              </button>
            ))}
          </div>
        </div>
      </Dropdown>

      <Dropdown
        label={`Filters${activeFilters ? ` · ${activeFilters}` : ""}`}
        active={activeFilters > 0}
        open={menu === "filters"}
        onToggle={(v) => setMenu(v ? "filters" : null)}
        width="w-[34rem] max-w-[90vw]"
      >
        <div className="p-3 space-y-2">
          {o.filters.length === 0 ? (
            <div className="text-sm text-stone-400">
              No filters yet — add one below. Filters combine with the search box, the progress chips and each other
              (AND).
            </div>
          ) : (
            o.filters.map((f, i) => (
              <FilterRow
                key={i}
                f={f}
                onChange={(next) => setFilter(i, next)}
                onRemove={() => patchOv({ filters: o.filters.filter((_, k) => k !== i) })}
              />
            ))
          )}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => patchOv({ filters: [...o.filters, { field: "progress", op: defaultOp("number"), value: "" }] })}
              className={BTN2}
            >
              + Add filter
            </button>
            {o.filters.length > 0 && (
              <button type="button" onClick={() => patchOv({ filters: [] })} className="text-sm text-sky-700 hover:underline">
                Clear filters
              </button>
            )}
          </div>
        </div>
      </Dropdown>

      {tab !== "flow" && (
        <Dropdown
          label={`Sort${o.sort.length ? ` · ${o.sort.length}` : ""}`}
          active={o.sort.length > 0}
          open={menu === "sort"}
          onToggle={(v) => setMenu(v ? "sort" : null)}
          width="w-64"
        >
          <div className="p-2 max-h-[60vh] overflow-auto">
            <div className="px-2 pb-1 text-[11px] text-stone-400">
              Click to sort · again to flip · third click removes. Levels stack in click order
              {tab === "list" ? "; shift-click a column header does the same" : ""}.
            </div>
            {sortMenuFields().map((key) => {
              const def = fieldDef(key)
              if (!def) {
                return null
              }
              const idx = o.sort.findIndex((s) => s.key === key)
              const on = idx >= 0
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => cycleSort(key, true)}
                  className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-sm ${on ? "bg-amber-50 text-stone-900" : "hover:bg-stone-50 text-stone-700"}`}
                >
                  {def.label}
                  {on && (
                    <span className="ml-auto inline-flex items-center gap-1 text-amber-700">
                      {o.sort.length > 1 && <span className="text-[10px] tabular-nums">{idx + 1}</span>}
                      {o.sort[idx]!.dir === -1 ? "▼" : "▲"}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </Dropdown>
      )}

      {anyState && (
        <button
          type="button"
          onClick={resetOvQuery}
          title="Clear search, filters and sorting"
          className="text-sm text-sky-700 hover:underline whitespace-nowrap"
        >
          Reset
        </button>
      )}

      <div className="ml-auto flex items-center gap-3">
        {res &&
          (ovActive() ? (
            <span className="text-xs text-stone-500 tabular-nums whitespace-nowrap">
              {res.total.toLocaleString()} of {records.length.toLocaleString()} match
            </span>
          ) : (
            <span className="text-xs text-stone-400 tabular-nums whitespace-nowrap">
              {records.length.toLocaleString()} case{records.length === 1 ? "" : "s"}
            </span>
          ))}
        {tab === "list" && (
          <Dropdown
            label="Columns"
            active={!!o.cols}
            open={menu === "cols"}
            onToggle={(v) => setMenu(v ? "cols" : null)}
            align="right"
            width="w-64"
          >
            <div className="p-2 max-h-[60vh] overflow-auto">
              {["id", "progress"].map((l) => (
                <label key={l} className="flex items-center gap-2 px-2 py-1 text-sm text-stone-400" title="Always shown">
                  <input type="checkbox" checked disabled className="accent-stone-400" /> {l}
                  <span className="ml-auto text-[10px] uppercase tracking-wide">always</span>
                </label>
              ))}
              {attrFieldKeys().length > 0 && (
                <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-stone-400">Attributes</div>
              )}
              {attrFieldKeys().map((k) => (
                <ColOption key={k} tok={k} label={prettyEntity(k)} records={records} />
              ))}
              <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-stone-400">System</div>
              {SYS_COL_TOKENS.map((t) => (
                <ColOption key={t} tok={t} label={colMeta(t).label} records={records} />
              ))}
              {o.cols && (
                <div className="px-2 pt-2">
                  <button type="button" onClick={() => setOvCols(null)} className="text-sm text-sky-700 hover:underline">
                    Reset to defaults
                  </button>
                </div>
              )}
            </div>
          </Dropdown>
        )}
      </div>

      <ActiveChips />
    </div>
  )
}

const ColOption = ({ tok, label, records }: { tok: string; label: string; records: CaseRecord[] }) => {
  useStore((s) => s.ov)
  const chosen = new Set(listColTokens(records))
  return (
    <label className="flex items-center gap-2 px-2 py-1 rounded text-sm text-stone-700 hover:bg-stone-50 cursor-pointer">
      <input
        type="checkbox"
        checked={chosen.has(tok)}
        onChange={(e) => toggleOvCol(records, tok, e.target.checked)}
        className="accent-amber-500"
      />{" "}
      {label}
    </label>
  )
}

// Dismissible chips for everything currently narrowing/ordering the view.
const ActiveChips = () => {
  const o = useStore((s) => s.ov)
  const chips: React.ReactNode[] = []

  if (o.prog) {
    chips.push(
      <span key="prog" className={CHIP}>
        {PROG_LABEL[o.prog]}
        <button type="button" onClick={() => patchOv({ prog: "" })} title="Show all progress states">
          ✕
        </button>
      </span>,
    )
  }
  if (o.activity.within) {
    chips.push(
      <span key="act" className={CHIP} title="Clear the activity window">
        {activityLabel(o.activity)}
        <button type="button" onClick={() => patchOv({ activity: { ...o.activity, within: "" } })}>
          ✕
        </button>
      </span>,
    )
  }
  o.filters.forEach((f, i) => {
    if (String(f.value ?? "") === "") {
      return
    }
    const def = fieldDef(f.field)
    if (!def) {
      return
    }
    chips.push(
      <span key={`f${i}`} className={CHIP} title="Remove this filter">
        {def.label} {opLabel(def.type, f.op)} {String(f.value)}
        <button type="button" onClick={() => patchOv({ filters: o.filters.filter((_, k) => k !== i) })}>
          ✕
        </button>
      </span>,
    )
  })
  o.sort.forEach((s, i) => {
    const def = fieldDef(s.key)
    if (!def) {
      return
    }
    chips.push(
      <span
        key={`s${s.key}`}
        className={`${CHIP} !bg-sky-50 !border-sky-200 !text-sky-900`}
        title="Click the arrow to flip, ✕ to remove"
      >
        {o.sort.length > 1 && <span className="tabular-nums text-[10px]">{i + 1}</span>}
        {def.label}
        <button type="button" onClick={() => flipSort(s.key)} className="font-semibold">
          {s.dir === -1 ? "▼" : "▲"}
        </button>
        <button type="button" onClick={() => removeSort(s.key)}>
          ✕
        </button>
      </span>,
    )
  })

  if (!chips.length) {
    return null
  }
  return <div className="flex flex-wrap items-center gap-1.5 w-full pt-1">{chips}</div>
}

export { attrColumns }
