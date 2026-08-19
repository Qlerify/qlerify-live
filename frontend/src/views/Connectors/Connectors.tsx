import { useEffect, useRef } from "react"
import { useRoute } from "@/lib/router.ts"
import { useStore } from "@/lib/store.ts"
import { connExportAll, connImportFile, connectorName, loadConnectors } from "@/lib/connectorsData.ts"
import type { Connector } from "@/lib/types.ts"
import { StatusDot } from "./StatusDot.tsx"
import { BehaviorBadge } from "./BehaviorBadge.tsx"
import { ConnectorDetail } from "./ConnectorDetail.tsx"

const ListRow = ({ c, selected, onSelect }: { c: Connector; selected: boolean; onSelect: () => void }) => (
  <button
    onClick={onSelect}
    className={`w-full text-left px-3 py-2.5 border-b border-stone-100 ${selected ? "bg-sky-50" : "hover:bg-stone-50"}`}
  >
    <div className="flex items-center gap-2">
      <StatusDot status={c.status} />
      <span className="text-sm font-medium text-stone-800 truncate">{connectorName(c)}</span>
      <BehaviorBadge behavior={c.behavior} className="ml-auto" />
    </div>
    <div className="text-[11px] text-stone-500 mt-0.5 truncate">
      {c.boundedContext} → {c.targetEntity}
      {c.status === "orphaned" ? " (missing)" : ""} · {c.rowCount} row(s)
    </div>
  </button>
)

// Hidden file input + the button that triggers it — the picker is styled as a
// normal button rather than a bare <input type=file>.
const ImportButton = ({ className }: { className: string }) => {
  const connBusy = useStore((s) => s.connBusy)
  const ref = useRef<HTMLInputElement>(null)

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = "" // allow re-picking the same file after a fix
    if (f) {
      connImportFile(f)
    }
  }

  return (
    <>
      <button
        onClick={() => ref.current?.click()}
        disabled={connBusy}
        title="Import connectors from a previously exported JSON backup — conflicts are skipped, never overwritten"
        className={className}
      >
        ⬆ Import
      </button>
      <input ref={ref} type="file" accept=".json,application/json" className="hidden" onChange={pick} />
    </>
  )
}

export const Connectors = () => {
  const route = useRoute()
  const { connectors, connSel, connError, connBusy, set } = useStore()

  useEffect(() => {
    // Deep link: #connectors/<id> preselects it.
    if (route.connSel) {
      set({ connSel: route.connSel })
    }
    loadConnectors().catch(() => {})
  }, [route.connSel, set])

  if (connError) {
    return (
      <main className="p-8">
        <div className="text-rose-600 text-sm">{connError}</div>
      </main>
    )
  }

  const list = connectors?.connectors || []

  if (!list.length) {
    return (
      <main className="flex-1 flex items-center justify-center p-10">
        <div className="text-center max-w-md">
          <div className="text-3xl mb-2">🔌</div>
          <div className="text-lg font-semibold text-stone-800">No connectors yet</div>
          <div className="text-sm text-stone-500 mt-1">
            Build one in{" "}
            <a href="#bcs" className="text-sky-700 hover:underline">
              Systems
            </a>
            : pick a table and choose “Build connector with AI”. Connectors show up here for management and
            re-pointing.
          </div>
          <div className="mt-4">
            <ImportButton className="px-4 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium" />
          </div>
        </div>
      </main>
    )
  }

  const orphaned = list.filter((c) => c.status === "orphaned")
  const active = list.filter((c) => c.status !== "orphaned")
  const selected = list.find((c) => c.id === connSel) || null

  const Section = ({ title, items, tone }: { title: string; items: Connector[]; tone: string }) => {
    if (!items.length) {
      return null
    }
    return (
      <>
        <div className={`px-3 py-1.5 text-[11px] uppercase tracking-wide ${tone} bg-stone-50 border-b border-stone-200`}>
          {title} ({items.length})
        </div>
        {items.map((c) => (
          <ListRow key={c.id} c={c} selected={connSel === c.id} onSelect={() => set({ connSel: c.id })} />
        ))}
      </>
    )
  }

  return (
    <main className="flex-1 flex min-h-0">
      <div className="w-[340px] border-r border-stone-200 overflow-y-auto bg-white">
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-stone-200 bg-stone-50">
          <ImportButton className="px-3 py-1 text-xs rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium" />
          <button
            onClick={connExportAll}
            disabled={connBusy}
            title="Download every connector in this workflow as one portable JSON backup — config, code, and credential field names (never secret values)"
            className="px-3 py-1 text-xs rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium"
          >
            ⬇ Export all ({list.length})
          </button>
        </div>
        <Section title="Needs attention" items={orphaned} tone="text-rose-600 font-semibold" />
        <Section title="Active" items={active} tone="text-stone-500" />
      </div>
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        <ConnectorDetail c={selected} />
      </div>
    </main>
  )
}
