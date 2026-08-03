import { useStore } from "../../lib/store.ts"
import type { ExpFilter } from "../../lib/types.ts"

const CONDS = ["Equal to", "Not equal to", "Contains", "Begins with", "Greater than", "Less than"]
const TYPES = ["String", "Number"]

type Props = {
  filters: ExpFilter[]
  columns: { name: string }[]
  onApply: () => void
  onReset: () => void
}

export const FiltersPanel = ({ filters, columns, onApply, onReset }: Props) => {
  const { exp, set } = useStore()

  const update = (i: number, field: keyof ExpFilter, value: string) => {
    const next = filters.map((f, k) => (k === i ? { ...f, [field]: value } : f))
    set({ exp: { ...exp, filters: next } })
  }

  const remove = (i: number) => {
    set({ exp: { ...exp, filters: filters.filter((_, k) => k !== i) } })
  }

  const add = () => {
    set({ exp: { ...exp, filters: [...filters, { attr: "", cond: "Equal to", type: "String", value: "" }] } })
  }

  return (
    <details open={filters.length > 0}>
      <summary className="text-sm font-medium text-stone-700 cursor-pointer select-none mb-2">
        Filters <span className="text-stone-400 font-normal italic">– optional</span>
      </summary>
      <datalist id="exp-attr-list">
        {columns.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>

      {filters.map((f, i) => (
        <div key={i} className="flex items-end gap-2 mb-2">
          <div className="flex-1">
            <label className="block text-[11px] text-stone-500 mb-0.5">Attribute name</label>
            <input
              list="exp-attr-list"
              value={f.attr}
              onChange={(e) => update(i, "attr", e.target.value)}
              placeholder="Enter attribute name"
              className="w-full text-sm border border-stone-300 rounded-md px-2 py-1.5"
            />
          </div>
          <div>
            <label className="block text-[11px] text-stone-500 mb-0.5">Condition</label>
            <select
              value={f.cond}
              onChange={(e) => update(i, "cond", e.target.value)}
              className="text-sm border border-stone-300 rounded-md px-2 py-1.5"
            >
              {CONDS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-stone-500 mb-0.5">Type</label>
            <select
              value={f.type}
              onChange={(e) => update(i, "type", e.target.value)}
              className="text-sm border border-stone-300 rounded-md px-2 py-1.5"
            >
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-[11px] text-stone-500 mb-0.5">Value</label>
            <input
              value={f.value}
              onChange={(e) => update(i, "value", e.target.value)}
              placeholder="Enter attribute value"
              className="w-full text-sm border border-stone-300 rounded-md px-2 py-1.5"
            />
          </div>
          <button onClick={() => remove(i)} className="px-3 py-1.5 text-sm text-sky-700 hover:underline whitespace-nowrap">
            Remove
          </button>
        </div>
      ))}

      <button
        onClick={add}
        className="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 mb-1"
      >
        Add filter
      </button>
      <div className="flex items-center gap-3 mt-1">
        <button
          onClick={onApply}
          className="px-5 py-1.5 text-sm rounded-full bg-amber-400 hover:bg-amber-500 text-stone-900 font-semibold"
        >
          Run
        </button>
        <button onClick={onReset} className="text-sm text-sky-700 hover:underline">
          Reset
        </button>
      </div>
    </details>
  )
}
