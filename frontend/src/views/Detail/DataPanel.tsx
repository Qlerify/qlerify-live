import { useStore } from "../../lib/store.ts"
import { activeDetailInstance, genAllRows, genBcByAgg } from "../../lib/asOf.ts"
import type { DiffCtx } from "../../lib/asOf.ts"
import { EntityCard } from "./EntityCard.tsx"

export const DataPanel = () => {
  const { instance, prevInstance, log, events, meta, selectedStep } = useStore()

  const { inst, asOfPrev } = activeDetailInstance(instance, log, events, selectedStep)
  const rows = genAllRows(inst, meta)
  const bcByAgg = genBcByAgg(inst)

  const ctx: DiffCtx = {
    baseline: selectedStep != null ? asOfPrev : prevInstance,
    hasBaseline: selectedStep != null ? asOfPrev != null : prevInstance != null,
    selected: selectedStep != null,
    log,
  }

  // Aggregate roots are independent consistency boundaries — they reference each
  // other by id but are never composed, so each renders as its own top-level box.
  const rootId = inst.root?.id
  const others = rows.filter((e) => !(e.agg === meta.rootAggregate && e.row.id === rootId))

  return (
    <main className="flex-1 overflow-auto p-6 flex flex-col gap-4">
      {inst.root && <EntityCard agg={meta.rootAggregate} row={inst.root} ctx={ctx} bcByAgg={bcByAgg} prominent />}
      {others.length > 0 && (
        <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))" }}>
          {others.map((e) => (
            <EntityCard
              key={`${e.agg}#${String(e.row.id)}`}
              agg={e.agg}
              row={e.row}
              ctx={ctx}
              bcByAgg={bcByAgg}
              prominent={false}
            />
          ))}
        </div>
      )}
    </main>
  )
}
