// Segment × step coverage matrix: rows = the values of one case attribute
// (region, market, industry…), columns = "not started" + the model steps, each
// cell = distinct-case coverage of that step within the segment. 268 cases are
// un-actionable one by one, but ~6 segments × the steps is one screenful, and in
// a same-birthday cohort segments are directly comparable — a pale cell is a
// pace problem owned by one team. Every cell drills to its worst-first worklist.
import { useState } from "react"
import { AUTH } from "@/lib/api.ts"
import { attrText, prettyEntity } from "@/lib/format.ts"
import { furthestIndex } from "@/lib/cohort.ts"
import { attrFieldKeys, stepNotFiredFilter } from "@/lib/ovquery.ts"
import type { CaseRecord, OvFilter } from "@/lib/ovquery.ts"
import { drillToList } from "@/lib/drill.ts"
import type { EventDef } from "@/lib/types.ts"

type Props = {
  records: CaseRecord[]
  events: EventDef[]
}

const MAX_GROUPS = 24
const prefKey = () => `ql.ov.${AUTH.workflow() || "-"}.flowMatrixAttr`

// Attributes that segment usefully: 2..MAX_GROUPS distinct non-empty values.
const segmentableAttrs = (records: CaseRecord[]): string[] => {
  const out: string[] = []
  for (const k of attrFieldKeys()) {
    const seen = new Set<string>()
    for (const r of records) {
      if (!r.row) {
        continue
      }
      const v = attrText(r.row[k])
      if (v && v !== "—") {
        seen.add(v)
      }
      if (seen.size > MAX_GROUPS) {
        break
      }
    }
    if (seen.size >= 2 && seen.size <= MAX_GROUPS) {
      out.push(k)
    }
  }
  return out
}

type MatrixRow = {
  name: string
  recs: CaseRecord[]
  /** null = not drillable (empty attr value or the synthetic rows). */
  filterValue: string | null
  uncorrelated?: boolean
  all?: boolean
}

const cellStat = (recs: CaseRecord[], ref: string) => {
  let covered = 0
  for (const r of recs) {
    if ((r.fr?.counts?.[ref] || 0) > 0) {
      covered++
    }
  }
  return covered
}

// Same rule as cohortStats.notStarted (no CURRENT-model event fired), so this
// column, the inlet node and the prog="none" drill all count the same set.
const notStartedCount = (recs: CaseRecord[], events: EventDef[]) =>
  recs.filter((r) => furthestIndex(events, r.fr) < 0).length

export const SegmentStepMatrix = ({ records, events }: Props) => {
  const attrs = segmentableAttrs(records)
  const [chosen, setChosen] = useState<string>(() => {
    try {
      return localStorage.getItem(prefKey()) || ""
    } catch {
      return ""
    }
  })
  const attr = attrs.includes(chosen) ? chosen : attrs[0]

  if (!attr || !events.length || records.length < 2) {
    return null
  }

  const pick = (k: string) => {
    setChosen(k)
    try {
      localStorage.setItem(prefKey(), k)
    } catch {
      /* private mode etc. */
    }
  }

  // Grouping matches the drill's semantics: the eq filter compares
  // case-insensitively, so two values differing only in case must be ONE row
  // (first-seen casing kept for display).
  const groups = new Map<string, { name: string; recs: CaseRecord[] }>()
  const orphans: CaseRecord[] = []
  for (const r of records) {
    if (!r.row) {
      orphans.push(r)
      continue
    }
    const v = attrText(r.row[attr])
    const name = v && v !== "—" ? v : "—"
    const key = name.toLowerCase()
    const g = groups.get(key)
    if (g) {
      g.recs.push(r)
    } else {
      groups.set(key, { name, recs: [r] })
    }
  }

  // Worst segments first: lowest mean step coverage on top — the row order IS
  // the priority order.
  const meanCoverage = (recs: CaseRecord[]) => {
    if (!recs.length) {
      return 0
    }
    let sum = 0
    for (const e of events) {
      sum += cellStat(recs, e.ref) / recs.length
    }
    return sum / events.length
  }

  const rows: MatrixRow[] = [
    { name: `All (${records.length})`, recs: records, filterValue: null, all: true },
    ...[...groups.values()]
      .map(({ name, recs }) => ({ name, recs, filterValue: name === "—" ? null : name }))
      .sort((x, y) => meanCoverage(x.recs) - meanCoverage(y.recs)),
  ]
  if (orphans.length) {
    rows.push({ name: "Uncorrelated", recs: orphans, filterValue: null, uncorrelated: true })
  }

  const drillCell = (row: MatrixRow, ref: string | null) => {
    const filters: OvFilter[] = []
    if (row.uncorrelated) {
      filters.push({ field: "uncorrelated", op: "gte", value: "1" })
    } else if (row.filterValue != null) {
      filters.push({ field: "a:" + attr, op: "eq", value: row.filterValue })
    }
    if (ref) {
      filters.push(stepNotFiredFilter(ref))
      drillToList(filters)
    } else {
      drillToList(filters, { prog: "none" })
    }
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white overflow-hidden max-w-5xl">
      <div className="px-4 py-2 border-b border-stone-200 bg-stone-50 flex items-center gap-3">
        <span className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">
          Segment × step coverage
        </span>
        <span className="text-[10px] text-stone-400">worst segment on top · every cell is a worklist</span>
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-stone-500">
          Segment by
          <select
            value={attr}
            onChange={(e) => pick(e.target.value)}
            className="text-xs border border-stone-300 rounded px-1.5 py-0.5 bg-white"
          >
            {attrs.map((k) => (
              <option key={k} value={k}>
                {prettyEntity(k)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-stone-500 bg-stone-50 border-b border-stone-200">
              <th className="px-3 py-1.5 font-medium">{prettyEntity(attr)}</th>
              <th className="px-2 py-1.5 font-medium text-stone-400">Not started</th>
              {events.map((e, i) => (
                <th key={e.ref} className="px-2 py-1.5 font-medium max-w-[9rem] truncate" title={e.name}>
                  {i + 1}. {e.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((row) => {
              const size = row.recs.length
              const ns = notStartedCount(row.recs, events)
              const drillable = row.all || row.uncorrelated || row.filterValue != null
              return (
                <tr key={row.name} className={row.uncorrelated ? "bg-stone-50/60" : row.all ? "bg-stone-50" : ""}>
                  <td
                    className={`px-3 py-1.5 whitespace-nowrap ${row.uncorrelated ? "text-stone-400 italic" : "text-stone-700 font-medium"}`}
                    title={
                      row.uncorrelated
                        ? "Event-log case ids with no case row — data drift, not pipeline; they carry no attributes"
                        : undefined
                    }
                  >
                    {row.name}
                    {!row.all && <span className="text-stone-400 font-normal"> · {size}</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    {ns > 0 ? (
                      <button
                        type="button"
                        disabled={!drillable}
                        onClick={() => drillCell(row, null)}
                        title={`${ns} of ${size} not started — click for the worklist`}
                        className="tabular-nums text-stone-500 disabled:cursor-default enabled:hover:underline"
                      >
                        {ns}
                      </button>
                    ) : (
                      <span className="text-stone-300">—</span>
                    )}
                  </td>
                  {events.map((e) => {
                    const covered = cellStat(row.recs, e.ref)
                    const pct = size ? Math.round((covered / size) * 100) : 0
                    return (
                      <td key={e.ref} className="px-0.5 py-0.5">
                        <button
                          type="button"
                          disabled={!drillable}
                          onClick={() => drillCell(row, e.ref)}
                          title={
                            drillable
                              ? `${covered} of ${size} (${pct}%) through "${e.name}" — click for the ${size - covered} missing`
                              : `${covered} of ${size} (${pct}%) through "${e.name}" (empty ${prettyEntity(attr)} — not filterable)`
                          }
                          className={`w-full rounded px-1.5 py-1 text-left tabular-nums disabled:cursor-default enabled:hover:ring-1 enabled:hover:ring-stone-400 ${pct < 50 ? "text-rose-800 font-semibold" : "text-stone-800"}`}
                          style={{ backgroundColor: `rgba(16,185,129,${(pct / 100) * 0.5})` }}
                        >
                          {covered}/{size}
                          <span className={`ml-1 ${pct < 50 ? "text-rose-700" : "text-stone-500"}`}>{pct}%</span>
                        </button>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
