import { GEN_HIDDEN } from "../../lib/asOf.ts"
import type { Row } from "../../lib/types.ts"
import { FieldValue } from "./FieldValue.tsx"

type Props = {
  name: string
  rows: Row[]
  changed: boolean
  prevRows: Row[] | null
}

export const EmbeddedTable = ({ name, rows, changed, prevRows }: Props) => {
  const cols = Object.keys(rows[0]!)
    .filter((c) => !GEN_HIDDEN.has(c))
    .slice(0, 6)

  // Light up the data rows that are new/different vs the previous step. With no
  // baseline every row counts as new; the header just carries an "updated" tag.
  const prevSet = prevRows ? prevRows.map((r) => JSON.stringify(r)) : null
  const isNew = (r: Row) => changed && (!prevSet || !prevSet.includes(JSON.stringify(r)))

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
          {rows.map((r, i) => (
            <tr key={i} className={`border-t border-stone-100 ${isNew(r) ? "row-changed" : ""}`}>
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 align-top text-stone-700">
                  <FieldValue name={c} value={r[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
