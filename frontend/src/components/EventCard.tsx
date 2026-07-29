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
}

export const EventCard = ({ event, index, count, maxCount, meta, left, top, width, height }: Props) => {
  const fired = count > 0
  const provMode = provModeForBC(meta, event.boundedContext)
  // Heat: relative volume → emerald tint. The floor keeps low-volume fired cards
  // visibly "on"; the ceiling stays readable.
  const heat = fired ? (0.1 + 0.45 * (count / maxCount)).toFixed(3) : "0"

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
    </div>
  )
}
