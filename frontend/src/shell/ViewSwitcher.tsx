import { useStore } from "../lib/store.ts"
import { ovQuerySuffix } from "../lib/ovquery.ts"

const SEGMENTS: [string, string, string][] = [
  ["#flow", "⑂ Workflow", "All cases merged onto one flow, with a counter on each event"],
  ["#rows", "▦ By case", "The same flow split into one row per case"],
  ["#list", "▤ List", "Every case as a list — pick one to follow it end to end"],
]

// The active search/filter/sort travels with the tab hop (page resets — it's
// per-tab), so a slice carved out in one representation persists in the next.
export const ViewSwitcher = ({ active }: { active: string }) => {
  useStore((s) => s.ov)
  const qs = ovQuerySuffix()
  return (
  <div
    className="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-stone-300 bg-stone-100 text-sm"
    role="group"
    aria-label="View"
  >
    {SEGMENTS.map(([href, label, title]) => {
      const on = href === `#${active}`
      const cls = on ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"
      return (
        <a
          key={href}
          href={href + qs}
          title={title}
          className={`px-2.5 py-1 rounded ${cls} whitespace-nowrap transition-colors`}
        >
          {label}
        </a>
      )
    })}
    </div>
  )
}
