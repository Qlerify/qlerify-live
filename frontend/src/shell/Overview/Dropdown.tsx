import { useEffect, useRef } from "react"

// A toolbar dropdown: a summary-styled trigger plus an absolutely-positioned
// panel. Open state is owned by the toolbar (one menu at a time); clicking
// outside closes it.
export const Dropdown = ({
  label,
  active,
  open,
  onToggle,
  align = "left",
  width,
  children,
}: {
  label: React.ReactNode
  active: boolean
  open: boolean
  onToggle: (open: boolean) => void
  align?: "left" | "right"
  width: string
  children: React.ReactNode
}) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      // A click on a control that re-rendered leaves its target detached — the
      // fresh DOM already reflects the intended state, so don't second-guess it.
      if (!t.isConnected) {
        return
      }
      if (ref.current && !ref.current.contains(t)) {
        onToggle(false)
      }
    }
    document.addEventListener("click", onDoc)
    return () => document.removeEventListener("click", onDoc)
  }, [open, onToggle])

  const tone = active
    ? "border-amber-400 bg-amber-50 text-amber-800"
    : "border-stone-300 bg-white hover:bg-stone-50"

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        className={`cursor-pointer select-none px-3 py-1.5 text-sm rounded-md border ${tone}`}
      >
        {label} <span className="text-stone-400">▾</span>
      </button>
      {open && (
        <div
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full mt-1 z-40 ${width} rounded-lg border border-stone-200 bg-white shadow-lg`}
        >
          {children}
        </div>
      )}
    </div>
  )
}
