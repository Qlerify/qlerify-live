import { useStore } from "@/lib/store.ts"
import { formatVersionDate, restoreWorkflowVersion, shortWorkflowUrl } from "@/lib/modelData.ts"

const SOURCE_TONE: Record<string, string> = {
  initial: "bg-stone-100 text-stone-500",
  restore: "bg-violet-100 text-violet-700",
}

export const VersionSidebar = () => {
  const { modelStatus, modelBusy } = useStore()

  if (!modelStatus) {
    return (
      <aside className="w-56 shrink-0 border-r border-stone-200 bg-white overflow-auto p-3 text-[11px] text-stone-400">
        Loading versions…
      </aside>
    )
  }

  const versions = modelStatus.versions || []
  if (versions.length === 0) {
    return (
      <aside className="w-56 shrink-0 border-r border-stone-200 bg-white overflow-auto p-3 text-[11px] text-stone-400 leading-relaxed">
        No saved versions yet.
      </aside>
    )
  }

  // Newest first.
  const ordered = versions.map((v, i) => ({ v, i })).reverse()

  return (
    <aside className="w-56 shrink-0 border-r border-stone-200 bg-white overflow-auto">
      <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-widest text-stone-500 font-semibold sticky top-0 bg-white">
        Versions
      </div>
      <ul className="px-2 pb-3 flex flex-col gap-1">
        {ordered.map(({ v, i }) => {
          const isCurrent = i === modelStatus.current
          const tone = SOURCE_TONE[v.source] || "bg-sky-100 text-sky-700"
          const events = v.summary?.events ?? 0
          const label = v.sourceName || (v.sourceUrl ? shortWorkflowUrl(v.sourceUrl) : "")
          const tip = v.sourceName ? `${v.sourceName} — ${v.sourceUrl}` : v.sourceUrl || ""

          return (
            <li
              key={v.id}
              className={`px-2.5 py-2 rounded-md border ${isCurrent ? "border-amber-300 bg-amber-50" : "border-transparent hover:bg-stone-50"} flex items-start gap-2`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold tabular-nums">v{i + 1}</span>
                  <span className={`text-[9px] uppercase tracking-wide px-1 py-0.5 rounded ${tone}`}>{v.source}</span>
                </div>
                <div className="text-[10px] text-stone-500 tabular-nums mt-0.5">{formatVersionDate(v.savedAt)}</div>
                <div className="text-[10px] text-stone-400 tabular-nums">{events} events</div>
                {v.sourceUrl ? (
                  <a
                    href={v.sourceUrl}
                    target="_blank"
                    rel="noopener"
                    title={`Fetched from ${tip}`}
                    className={`block text-[10px] ${v.sourceName ? "" : "mono "}text-sky-700 hover:text-sky-900 truncate mt-0.5`}
                  >
                    {label} ↗
                  </a>
                ) : (
                  <div className="text-[10px] text-stone-300 italic mt-0.5">uploaded / pasted</div>
                )}
              </div>
              {isCurrent ? (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 shrink-0 mt-0.5">
                  current
                </span>
              ) : (
                <button
                  onClick={() => restoreWorkflowVersion(v.id)}
                  disabled={modelBusy}
                  title="Restore this version"
                  className="text-[10px] px-2 py-1 rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 shrink-0 mt-0.5"
                >
                  Restore
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
