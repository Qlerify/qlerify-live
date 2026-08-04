// Why a derived event fired (twin/derive.ts evidence rules). The kind is the
// scenario the data matched; headline phrases it for the event log. No kind = a
// synthetic/simulator-stepped event, which carries no row-state evidence.
export const EVIDENCE_KIND: Record<string, { label: string; icon: string; chip: string; headline: string }> = {
  create: {
    label: "NEW ROW",
    icon: "🆕",
    chip: "bg-emerald-100 text-emerald-700 border border-emerald-200",
    headline: "A new record was created with its required fields",
  },
  status: {
    label: "STATUS",
    icon: "🔀",
    chip: "bg-violet-100 text-violet-700 border border-violet-200",
    headline: "The record reached the status this event represents",
  },
  fields: {
    label: "NEW FIELD",
    icon: "✏️",
    chip: "bg-amber-100 text-amber-700 border border-amber-200",
    headline: "This event introduced new field values on the record",
  },
  none: {
    label: "SEQUENCE",
    icon: "↪",
    chip: "bg-stone-100 text-stone-500 border border-stone-200",
    headline: "No row-state evidence — derived from sequence position",
  },
}

export const EvidenceChip = ({ kind }: { kind?: string }) => {
  const e = kind ? EVIDENCE_KIND[kind] : undefined
  if (!e) {
    return null
  }
  return (
    <span className={`text-[9px] font-semibold px-1 py-px rounded ${e.chip}`} title={e.headline}>
      {e.label}
    </span>
  )
}
