import { provHatch, provModeForBC } from "../lib/prov.ts"
import { PHASE_TONE } from "../lib/tone.ts"
import type { EventDef, Meta } from "../lib/types.ts"
import { ProvChip } from "./ProvChip.tsx"

type Props = {
  event: EventDef
  index: number
  count: number
  maxCount: number
  meta: Meta
  left: number
  top: number
  width: number
  height: number
  footer?: React.ReactNode
  /** Distinct-case coverage 0..1. When given, the tint encodes progress toward
   * 100%-of-cases (the merged view's goal) instead of relative firing volume —
   * so a step covered by few cases reads pale even when it multi-fires a lot. */
  coverage?: number
}

export const EventCard = ({ event, index, count, maxCount, meta, left, top, width, height, footer, coverage }: Props) => {
  const fired = count > 0
  const provMode = provModeForBC(meta, event.boundedContext)
  // Heat: emerald tint. Coverage mode scales with the share of cases through the
  // step; volume mode (per-case rows) with relative firing count. The floor
  // keeps low but non-zero cards visibly "on"; the ceiling stays readable.
  const heat =
    coverage != null
      ? coverage > 0
        ? (0.08 + 0.5 * Math.min(1, coverage)).toFixed(3)
        : "0"
      : fired
        ? (0.1 + 0.45 * (count / maxCount)).toFixed(3)
        : "0"

  return (
    <div
      className={`absolute rounded-md border ${fired ? "border-emerald-300" : PHASE_TONE[event.phase ?? 0] || "border-stone-300"} bg-white px-3 py-2 ${fired ? "" : "opacity-60"} flex flex-col overflow-hidden`}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: fired ? `rgba(16,185,129,${heat})` : undefined,
        backgroundImage: provHatch(provMode) || undefined,
      }}
    >
      <div className="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
        <span className="truncate">
          {index + 1}. {event.boundedContext}
        </span>
        <ProvChip mode={provMode} />
      </div>
      <div className="text-[12px] font-medium leading-tight text-stone-800">{event.name}</div>
      <div className="text-[10px] text-stone-500 mt-1">{event.role}</div>
      {footer}
    </div>
  )
}
