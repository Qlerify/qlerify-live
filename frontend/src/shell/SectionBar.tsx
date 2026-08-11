import { WORKFLOW_SCOPED_VIEWS } from "@/lib/router.ts"
import { AUTH } from "@/lib/api.ts"

const TABS: [string, string, string][] = [
  ["#", "Overview", "Live ops — instances in flight for this workflow"],
  ["#model", "Model", "Qlerify model — versions, source link, and workflow.json"],
  ["#bcs", "Systems", "Data sources and connectors for this workflow"],
  ["#connectors", "Connectors", "All data connectors for this workflow — details, re-point, delete"],
]

const isActive = (href: string, view: string): boolean => {
  if (href === "#") {
    return ["dashboard", "detail", "flow", "rows", "todo", "overview"].includes(view)
  }
  if (href === "#model") {
    return view === "model"
  }
  if (href === "#bcs") {
    return view === "bcs"
  }
  return view === "connectors"
}

export const SectionBar = ({ view }: { view: string }) => {
  if (!WORKFLOW_SCOPED_VIEWS.has(view) || !AUTH.workflow()) {
    return null
  }

  return (
    <div className="bg-stone-50 text-sm border-b border-stone-200">
      <div className="px-6 flex items-center gap-6">
        {TABS.map(([href, label, title]) => {
          const active = isActive(href, view)
          const cls = active
            ? "border-stone-900 text-stone-900 font-medium"
            : "border-transparent text-stone-500 hover:text-stone-800 hover:border-stone-300"
          return (
            <a key={href} href={href} title={title} className={`py-2.5 -mb-px border-b-2 ${cls} whitespace-nowrap`}>
              {label}
            </a>
          )
        })}
      </div>
    </div>
  )
}
