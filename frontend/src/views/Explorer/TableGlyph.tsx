import { useState } from "react"

const STATUS_DOT: Record<string, string> = {
  live: "bg-emerald-500",
  simulated: "bg-sky-500",
  wired_empty: "bg-white border-2 border-amber-400",
  no_adapter: "bg-white border-2 border-stone-300",
}

const STATUS_LABEL: Record<string, string> = {
  live: "Live data — connected to a live source",
  simulated: "Simulated / recorded data",
  wired_empty: "Connector configured, but no data pulled yet",
  no_adapter: "No connector — not connected to a source",
}

const TYPE_TIP = {
  valueObject: "Value object — defined only by its attributes, no identity of its own",
  entity: "Entity — a thing with a unique identity and its own lifecycle",
}

// Shape encodes type (square = entity, diamond = value object); colour encodes
// the 4-state connection status. Both are spelled out on hover.
export const TableGlyph = ({ kind, status }: { kind: string; status: string }) => {
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null)
  const vo = kind === "valueObject"

  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setTip({ left: r.right + 8, top: r.top })
  }

  return (
    <span
      onMouseEnter={(ev) => show(ev.currentTarget)}
      onMouseLeave={() => setTip(null)}
      className="shrink-0 inline-flex items-center justify-center p-1 -m-1 cursor-help"
    >
      <span className={`w-2.5 h-2.5 rounded-sm ${vo ? "rotate-45" : ""} ${STATUS_DOT[status] || STATUS_DOT.no_adapter}`} />
      {tip && (
        <span
          className="fixed z-50 w-64 rounded-lg border border-stone-200 bg-white shadow-xl text-xs overflow-hidden pointer-events-none"
          style={{ left: `${Math.min(tip.left, window.innerWidth - 264)}px`, top: `${tip.top}px` }}
        >
          <span className="block px-3 py-2 border-b border-stone-100">
            <span className="block text-[10px] uppercase tracking-widest text-stone-400 mb-0.5">Type</span>
            <span className="block text-stone-700 leading-snug">{vo ? TYPE_TIP.valueObject : TYPE_TIP.entity}</span>
          </span>
          <span className="block px-3 py-2">
            <span className="block text-[10px] uppercase tracking-widest text-stone-400 mb-0.5">Status</span>
            <span className="block text-stone-700 leading-snug">{STATUS_LABEL[status] || status}</span>
          </span>
        </span>
      )}
    </span>
  )
}
