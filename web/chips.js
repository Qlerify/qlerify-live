// Provenance & evidence presentation — the small badges/hatch that show where a
// fact came from and why a derived event fired. Pure except provModeForBC, which
// reads the shared model meta. Extracted from app.js.

import { state } from "./state.js";

// Provenance (Part 2.1): where a fact came from. Colorblind-safe — the dashed
// border + 3-letter label distinguish modes without relying on hue alone.
export const PROV_STYLE = {
  simulated: { label: "SIM",  chip: "bg-stone-100 text-stone-500 border border-dashed border-stone-300", title: "Simulated — synthesized locally, no real source connected" },
  recorded:  { label: "REC",  chip: "bg-sky-100 text-sky-700 border border-sky-200",                     title: "Recorded — captured from a real source, replayed offline" },
  live:      { label: "LIVE", chip: "bg-emerald-100 text-emerald-700 border border-emerald-200",         title: "Live — pulled from the connected source system" },
};
// Small provenance chip; unstamped/legacy facts read as simulated.
export function provChip(mode) {
  const s = PROV_STYLE[mode] || PROV_STYLE.simulated;
  return `<span class="text-[9px] font-semibold px-1 py-px rounded ${s.chip}" title="${s.title}">${s.label}</span>`;
}

// Why a derived event fired (twin/derive.ts evidence rules). The `kind` is the
// scenario the data matched; `headline` phrases it for the event log. Null kind =
// a synthetic/simulator-stepped event, which carries no row-state evidence.
export const EVIDENCE_KIND = {
  create: { label: "NEW ROW",   icon: "🆕", chip: "bg-emerald-100 text-emerald-700 border border-emerald-200", headline: "A new record was created with its required fields" },
  status: { label: "STATUS",    icon: "🔀", chip: "bg-violet-100 text-violet-700 border border-violet-200",     headline: "The record reached the status this event represents" },
  fields: { label: "NEW FIELD", icon: "✏️", chip: "bg-amber-100 text-amber-700 border border-amber-200",       headline: "This event introduced new field values on the record" },
  none:   { label: "SEQUENCE",  icon: "↪",  chip: "bg-stone-100 text-stone-500 border border-stone-200",       headline: "No row-state evidence — derived from sequence position" },
};
export function evidenceChip(kind) {
  const e = EVIDENCE_KIND[kind];
  if (!e) return "";
  return `<span class="text-[9px] font-semibold px-1 py-px rounded ${e.chip}" title="${e.headline}">${e.label}</span>`;
}
// Faint diagonal hatch so simulated step cards read as "ghosted" vs solid real
// data (Tailwind has no hatch utility → inline style). "" for real modes.
export function provHatch(mode) {
  return mode && mode !== "simulated"
    ? ""
    : "background-image:repeating-linear-gradient(45deg,rgba(120,113,108,0.06) 0 6px,transparent 6px 12px);";
}
// The configured mode for a bounded context (from /sim/meta), default simulated.
export function provModeForBC(bc) {
  return state.meta.provenance?.byContext?.[bc]?.mode || "simulated";
}
