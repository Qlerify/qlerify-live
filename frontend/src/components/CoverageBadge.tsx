// The merged flow's corner badge: DISTINCT-CASE coverage toward the 100% goal
// ("249/268"), never total firings — repeats would inflate past the cohort size.
// Colour encodes gap-to-target, so the emptiest step is the loudest card, and
// clicking drills to the cases still missing the step. (The per-case Rows view
// keeps its ×N FlowCountBadge — firing counts are the right unit there.)

// Shared coverage → tone ramp (badge, matrix cells, strip fragments).
export const coverageTone = (pct: number): string => {
  if (pct >= 100) {
    return "bg-emerald-500"
  }
  if (pct >= 50) {
    return "bg-amber-500"
  }
  return "bg-rose-500"
}

type Props = {
  covered: number
  denom: number
  firings: number
  name: string
  cx: number
  cy: number
  onClick?: () => void
}

export const CoverageBadge = ({ covered, denom, firings, name, cx, cy, onClick }: Props) => {
  if (!denom) {
    return null
  }
  const pct = Math.round((covered / denom) * 100)

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault()
          onClick()
        }
      }}
      className={`absolute z-10 flex items-center justify-center rounded-full ${coverageTone(pct)} text-white text-[9px] font-bold leading-none shadow ring-2 ring-white ${onClick ? "cursor-pointer hover:brightness-110" : ""}`}
      style={{
        left: `${cx}px`,
        top: `${cy}px`,
        transform: "translate(-50%,-50%)",
        minWidth: "20px",
        height: "18px",
        padding: "0 5px",
      }}
      title={`${covered} of ${denom} cases (${pct}%) fired ${name} · ${firings} firing${firings === 1 ? "" : "s"} incl. repeats — click for the cases not yet through`}
    >
      {covered}/{denom}
    </div>
  )
}
