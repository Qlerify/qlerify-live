import { useLayoutEffect, useRef, useState } from "react"
import { Pill } from "@/components/Pill.tsx"

// Values shorter than this can never meaningfully overflow the clamp, so they
// skip the measuring wrapper and render exactly as before.
const LONG = 140

// Clamp long content to a few lines with a Show more / Show less toggle. For
// plain text the toggle only appears when the clamp actually hides something —
// measured from the DOM (not character count) so it tracks the column width.
// `alwaysToggle` is for values whose expanded form differs from the collapsed
// one (pretty-printed JSON): that view must stay reachable even when the
// compact form happens to fit.
const ClampedValue = ({
  collapsed,
  expanded,
  className = "",
  alwaysToggle = false,
}: {
  collapsed: string
  expanded: string
  className?: string
  alwaysToggle?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // An expansion applies to the value the user expanded, never to whatever
  // replaces it — timeline scrubs and live events swap values in place.
  const [prevCollapsed, setPrevCollapsed] = useState(collapsed)
  if (collapsed !== prevCollapsed) {
    setPrevCollapsed(collapsed)
    setOpen(false)
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) {
      return
    }
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1)
    measure()
    // A webfont swap can push text past the clamp without changing the box,
    // which the observer alone would miss.
    document.fonts?.ready.then(measure)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed, open])

  return (
    <div>
      <div ref={ref} className={`${className} break-words ${open ? "whitespace-pre-wrap" : "line-clamp-3"}`}>
        {open ? expanded : collapsed}
      </div>
      {(clipped || open || alwaysToggle) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="text-[10px] text-stone-400 hover:text-stone-700 underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}

export const FieldValue = ({ name, value }: { name: string; value: unknown }) => {
  if (value == null || value === "") {
    return <>—</>
  }
  if (name === "status") {
    return <Pill text={String(value)} status={String(value)} />
  }
  if (typeof value === "object") {
    const compact = JSON.stringify(value)
    const cls = "mono text-[11px] text-stone-500"
    if (compact.length <= LONG) {
      return <span className={cls}>{compact}</span>
    }
    return <ClampedValue collapsed={compact} expanded={JSON.stringify(value, null, 2)} className={cls} alwaysToggle />
  }
  const text = String(value)
  if (text.length <= LONG) {
    return <>{text}</>
  }
  return <ClampedValue collapsed={text} expanded={text} />
}
