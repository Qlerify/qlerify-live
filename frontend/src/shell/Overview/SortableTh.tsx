import { cycleSort } from "../../lib/ovquery.ts"
import { useStore } from "../../lib/store.ts"

// Click = sort by this column (toggling direction); shift-click = stack it as an
// extra level.
export const SortableTh = ({ sortKey, label, className = "" }: { sortKey: string; label: string; className?: string }) => {
  const o = useStore((s) => s.ov)
  const idx = o.sort.findIndex((s) => s.key === sortKey)
  const on = idx >= 0
  const dir = on ? o.sort[idx]!.dir : 0

  return (
    <th className={`px-4 py-2 font-medium ${className}`} aria-sort={on ? (dir === -1 ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        onClick={(e) => cycleSort(sortKey, e.shiftKey)}
        title={`Sort by ${label} — click again to flip; shift-click to stack sort levels`}
        className="group/th inline-flex items-center gap-1 uppercase tracking-wide hover:text-stone-800 cursor-pointer"
      >
        {label}{" "}
        {on ? (
          <span className="text-amber-600">
            {o.sort.length > 1 && <sup className="tabular-nums">{idx + 1}</sup>}
            {dir === -1 ? "▼" : "▲"}
          </span>
        ) : (
          <span className="opacity-0 group-hover/th:opacity-40">▲</span>
        )}
      </button>
    </th>
  )
}
