import { PAGE_SIZES, pageAction, setOvPageSize } from "../../lib/ovquery.ts"
import { useStore } from "../../lib/store.ts"
import type { QueryResult } from "../../lib/ovquery.ts"

// Shared by the List footer and the By-case banner.
export const OvPager = ({ tab, res }: { tab: "list" | "rows"; res: QueryResult }) => {
  const o = useStore((s) => s.ov)
  const t = o.tab[tab]

  const btn = (act: string, label: string, disabled: boolean, title: string) => (
    <button
      type="button"
      onClick={() => pageAction(tab, act)}
      disabled={disabled}
      title={title}
      className={`px-2 py-0.5 rounded hover:bg-stone-100 ${disabled ? "opacity-40 cursor-default" : ""}`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex items-center gap-2 text-sm text-stone-600">
      <label className="flex items-center gap-1.5 text-xs text-stone-500">
        Per page
        <select
          value={t.pageSize}
          onChange={(e) => setOvPageSize(tab, Number(e.target.value))}
          className="text-sm border border-stone-300 rounded-md px-2 py-0.5 bg-white text-xs"
        >
          {(PAGE_SIZES[tab] || []).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className="tabular-nums text-xs text-stone-500 whitespace-nowrap">
        {res.from.toLocaleString()}–{res.to.toLocaleString()} of {res.total.toLocaleString()}
      </span>
      {btn("first", "«", res.page === 0, "First page")}
      {btn("prev", "‹", res.page === 0, "Previous page")}
      <span className="tabular-nums text-xs whitespace-nowrap">
        {res.page + 1} / {res.pages}
      </span>
      {btn("next", "›", res.page >= res.pages - 1, "Next page")}
      {btn("last", "»", res.page >= res.pages - 1, "Last page")}
    </div>
  )
}
