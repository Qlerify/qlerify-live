import type { ProvMode } from "../lib/types.ts"

// Colourblind-safe: the dashed border + 3-letter label distinguish modes without
// relying on hue alone.
export const PROV_STYLE: Record<string, { label: string; chip: string; title: string }> = {
  simulated: {
    label: "SIM",
    chip: "bg-stone-100 text-stone-500 border border-dashed border-stone-300",
    title: "Simulated — synthesized locally, no real source connected",
  },
  recorded: {
    label: "REC",
    chip: "bg-sky-100 text-sky-700 border border-sky-200",
    title: "Recorded — captured from a real source, replayed offline",
  },
  live: {
    label: "LIVE",
    chip: "bg-emerald-100 text-emerald-700 border border-emerald-200",
    title: "Live — pulled from the connected source system",
  },
}

// Unstamped/legacy facts read as simulated.
export const ProvChip = ({ mode }: { mode?: ProvMode }) => {
  const s = PROV_STYLE[mode || "simulated"] || PROV_STYLE.simulated!
  return (
    <span className={`text-[9px] font-semibold px-1 py-px rounded ${s.chip}`} title={s.title}>
      {s.label}
    </span>
  )
}
