import { GEN_HIDDEN, genFieldChanged, genParseRows, genPrevCollection, genRowChanged, shortId } from "../../lib/asOf.ts"
import type { DiffCtx } from "../../lib/asOf.ts"
import { prettyEntity } from "../../lib/format.ts"
import type { Row } from "../../lib/types.ts"
import { FieldValue } from "./FieldValue.tsx"
import { EmbeddedTable } from "./EmbeddedTable.tsx"

type Props = {
  agg: string
  row: Row
  ctx: DiffCtx
  bcByAgg: Record<string, string>
  prominent: boolean
}

export const EntityCard = ({ agg, row, ctx, bcByAgg, prominent }: Props) => {
  const changed = genRowChanged(ctx, agg, row)

  const scalars: [string, unknown][] = []
  const collections: [string, Row[]][] = []
  for (const [k, v] of Object.entries(row)) {
    if (GEN_HIDDEN.has(k) || k === "id") {
      continue
    }
    const sub = genParseRows(v)
    if (sub) {
      collections.push([k, sub])
    } else {
      scalars.push([k, v])
    }
  }

  const bc = bcByAgg[agg]
  const gridCols = prominent
    ? "md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
    : "sm:grid-cols-2"

  return (
    <div
      className={`rounded-lg border ${changed ? "border-amber-300 ring-1 ring-amber-200" : "border-stone-200"} bg-white ${prominent ? "p-4" : "p-3"}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`font-semibold text-stone-800 ${prominent ? "text-sm" : "text-[12px]"}`}>
          {prettyEntity(agg)}
        </span>
        {bc && (
          <span className="text-[10px] px-1.5 py-px rounded bg-stone-100 text-stone-500 border border-stone-200">
            {bc}
          </span>
        )}
        {row.id != null && <span className="mono text-[11px] text-stone-400">{shortId(String(row.id))}</span>}
        {changed && (
          <span className="text-[10px] px-1.5 py-px rounded bg-amber-100 text-amber-800 font-semibold uppercase tracking-wide">
            updated
          </span>
        )}
      </div>

      <div className={`grid grid-cols-2 ${gridCols} gap-x-4 gap-y-1.5`}>
        {scalars.map(([k, v]) => {
          const fc = genFieldChanged(ctx, agg, row, k)
          return (
            <div key={k}>
              <div className="text-[10px] text-stone-500">{k}</div>
              <div className={`text-[12px] text-stone-800 break-words ${fc ? "field-changed inline-block px-1" : ""}`}>
                <FieldValue name={k} value={v} />
              </div>
            </div>
          )
        })}
      </div>

      {collections.length > 0 && (
        <div className="mt-2 grid gap-3 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
          {collections.map(([k, sub]) => (
            <EmbeddedTable
              key={k}
              name={k}
              rows={sub}
              changed={genFieldChanged(ctx, agg, row, k)}
              prevRows={genPrevCollection(ctx, agg, row, k)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
