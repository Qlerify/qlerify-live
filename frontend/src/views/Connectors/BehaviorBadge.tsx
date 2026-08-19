import { behaviorVerb } from "@/lib/connectorBehavior.ts"
import type { AdapterBehavior } from "@/lib/types.ts"

// Amber for the actuator on purpose: it is the only type whose runs change
// something outside this system, and the badge is often the only warning on
// screen before someone presses run.
const TONE: Record<AdapterBehavior, string> = {
  sync: "bg-stone-100 text-stone-600",
  generator: "bg-violet-50 text-violet-700",
  actuator: "bg-amber-100 text-amber-800",
  extractor: "bg-sky-50 text-sky-700",
}

export const BehaviorBadge = ({ behavior, className = "" }: { behavior?: AdapterBehavior; className?: string }) => {
  const b = behavior ?? "sync"
  return (
    <span
      title={`${b} — ${behaviorVerb(b)}`}
      className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${TONE[b]} ${className}`}
    >
      {b}
    </span>
  )
}
