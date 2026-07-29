type Props = {
  n: number
  cx: number
  cy: number
  title?: string
}

// The emerald "×N" corner bubble, hidden at n≤1. (cx, cy) is the card's top-right
// corner; the translate centres it there.
export const FlowCountBadge = ({ n, cx, cy, title }: Props) => {
  if (!n || n <= 1) {
    return null
  }

  return (
    <div
      className="absolute z-10 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-none shadow ring-2 ring-white"
      style={{
        left: `${cx}px`,
        top: `${cy}px`,
        transform: "translate(-50%,-50%)",
        minWidth: "20px",
        height: "18px",
        padding: "0 5px",
      }}
      title={title || `Fired ${n}×`}
    >
      ×{n}
    </div>
  )
}
