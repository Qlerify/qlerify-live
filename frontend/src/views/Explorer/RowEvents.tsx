import { formatVersionDate } from "@/lib/modelData.ts"
import type { ExpRowEvent } from "@/lib/types.ts"

const DOT: Record<string, string> = {
  live: "bg-emerald-500",
  recorded: "bg-violet-500",
  simulated: "bg-sky-500",
}
const LABEL: Record<string, string> = { live: "Live", recorded: "Recorded", simulated: "Simulated" }

// A null businessAt means the moment is UNKNOWN (no source anchor) — the chip
// shows no time rather than passing off occurredAt (derivation/ingestion
// wall-clock) as when the event happened; the tooltip still cites it, labelled.
const EventChip = ({ ev }: { ev: ExpRowEvent }) => {
  const prov = ev.provenance || "simulated"
  const when = ev.businessAt
  const tip = [
    `${LABEL[prov] || prov} event`,
    ev.role ? `Role: ${ev.role}` : "",
    ev.evidence ? `Evidence: ${ev.evidence}` : "",
    when
      ? `When: ${formatVersionDate(when)}`
      : ev.occurredAt
        ? `Recorded: ${formatVersionDate(ev.occurredAt)} (business time unknown)`
        : "",
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <span
      title={tip}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-stone-200 bg-white text-[11px] text-stone-700 max-w-full"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[prov] || DOT.simulated}`} />
      <span className="font-medium truncate">{ev.eventName}</span>
      {when && <span className="text-stone-400 ml-0.5 shrink-0">{formatVersionDate(when)}</span>}
    </span>
  )
}

export const RowEventsCell = ({ events, busy }: { events?: ExpRowEvent[]; busy: boolean }) => (
  <td className="px-3 py-2 align-top border-l border-stone-100">
    <div className="flex flex-col items-start gap-1">
      {busy && !events?.length ? (
        <span className="text-[11px] text-stone-400 italic">Loading…</span>
      ) : !events?.length ? (
        <span className="text-[11px] text-stone-400 italic">No events fired</span>
      ) : (
        events.map((ev, i) => <EventChip key={i} ev={ev} />)
      )}
    </div>
  </td>
)
