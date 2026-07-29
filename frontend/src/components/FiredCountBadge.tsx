type Props = {
  n: number
  cx: number
  cy: number
  isOpen: boolean
  onToggle: () => void
}

// Clickable twin of FlowCountBadge: toggles per-firing expansion for this card.
// When open it reads as pressed (amber ring) so collapsing is discoverable.
export const FiredCountBadge = ({ n, cx, cy, isOpen, onToggle }: Props) => {
  if (!n || n <= 1) {
    return null
  }

  const activate = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onToggle()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          activate(e)
        }
      }}
      className={`absolute z-10 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-none shadow ring-2 ${isOpen ? "ring-amber-400" : "ring-white"} cursor-pointer hover:bg-emerald-600`}
      style={{
        left: `${cx}px`,
        top: `${cy}px`,
        transform: "translate(-50%,-50%)",
        minWidth: "20px",
        height: "18px",
        padding: "0 5px",
      }}
      title={isOpen ? "Click to collapse" : `Fired ${n}× for this case — click to expand each firing into its own row`}
    >
      ×{n}
    </div>
  )
}
