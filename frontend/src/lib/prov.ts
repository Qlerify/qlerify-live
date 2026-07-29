import type { Meta, ProvMode } from "./types.ts"

// Faint diagonal hatch so simulated cards read as "ghosted" vs solid real data
// (Tailwind has no hatch utility). Empty for real modes.
export const provHatch = (mode?: ProvMode): string => {
  if (mode && mode !== "simulated") {
    return ""
  }
  return "repeating-linear-gradient(45deg,rgba(120,113,108,0.06) 0 6px,transparent 6px 12px)"
}

export const provModeForBC = (meta: Meta, bc: string): ProvMode =>
  meta.provenance?.byContext?.[bc]?.mode || "simulated"
