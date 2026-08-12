import { useState } from "react"
import { GEN_HIDDEN } from "@/lib/asOf.ts"
import type { Row } from "@/lib/types.ts"
import { FieldValue } from "./FieldValue.tsx"

// A big collection must not fill the screen on first visit: show the first few
// rows and let the user expand the rest.
const ROW_CAP = 5

type Props = {
  name: string
  rows: Row[]
  changed: boolean
  prevRows: Row[] | null
}

export const EmbeddedTable = ({ name, rows, changed, prevRows }: Props) => {
  const [userToggle, setUserToggle] = useState<boolean | null>(null)

  const cols = Object.keys(rows[0]!)
    .filter((c) => !GEN_HIDDEN.has(c))
    .slice(0, 6)

  // Light up the data rows that are new/different vs the previous step. With no
  // baseline every row counts as new; the header just carries an "updated" tag.
  const prevSet = prevRows ? prevRows.map((r) => JSON.stringify(r)) : null
  const rowJson = rows.map((r) => JSON.stringify(r))
  const isNew = (json: string) => changed && (!prevSet || !prevSet.includes(json))

  // The expand/collapse choice applies to the snapshot it was made on; when the
  // collection changes (step scrub, live event) it resets and the auto-expand
  // rule below re-applies. JSON strings hold no raw newlines, so the join is
  // collision-free.
  const sig = rowJson.join("\n")
  const [prevSig, setPrevSig] = useState(sig)
  if (sig !== prevSig) {
    setPrevSig(sig)
    setUserToggle(null)
  }

  // Never hide a highlighted diff row behind the cap — auto-expand unless the
  // user explicitly collapsed. Only with a real baseline: without one every
  // row counts as new, and first visit is exactly when the cap matters most.
  const hiddenHasNew = prevSet != null && rowJson.slice(ROW_CAP).some(isNew)
  const expanded = userToggle ?? hiddenHasNew
  const shown = expanded ? rows : rows.slice(0, ROW_CAP)

  // Cells are stateful now (Show more), so keys must follow row content, not
  // row position; duplicate rows get an occurrence suffix to stay unique.
  const seen = new Map<string, number>()
  const keys = rowJson.map((json) => {
    const n = seen.get(json) ?? 0
    seen.set(json, n + 1)
    return n === 0 ? json : `${json}#${n}`
  })

  return (
    <div className={`overflow-hidden rounded border ${changed ? "border-amber-300" : "border-stone-200"}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide px-2 py-1 border-b text-stone-500 bg-stone-50 border-stone-200">
        {name} <span className="text-stone-400 font-normal">· {rows.length}</span>
        {changed && <span className="ml-1 px-1 rounded bg-amber-200 text-amber-900 font-semibold">updated</span>}
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className="text-left font-medium text-stone-400 px-2 py-1">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={keys[i]} className={`border-t border-stone-100 ${isNew(rowJson[i]!) ? "row-changed" : ""}`}>
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 align-top text-stone-700">
                  <FieldValue name={c} value={r[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > ROW_CAP && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setUserToggle(!expanded)}
          className="w-full text-left text-[10px] px-2 py-1 border-t border-stone-100 text-stone-400 hover:text-stone-700 hover:bg-stone-50"
        >
          {expanded ? "Show less" : `Show all ${rows.length} rows`}
        </button>
      )}
    </div>
  )
}
