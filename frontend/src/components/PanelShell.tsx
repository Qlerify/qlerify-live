import type { ReactNode } from "react"

export const PanelShell = ({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) => (
  <section className="rounded-lg border border-stone-200 bg-white overflow-hidden">
    <div className="px-4 py-3 border-b border-stone-100">
      <div className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">{eyebrow}</div>
      <div className="text-sm font-semibold text-stone-800">{title}</div>
    </div>
    <div className="p-4">{children}</div>
  </section>
)

export const MiniStat = ({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) => (
  <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-center">
    <div className={`text-xl font-semibold tabular-nums ${tone || "text-stone-900"}`}>{value}</div>
    <div className="text-[10px] uppercase tracking-wide text-stone-500 mt-0.5">{label}</div>
  </div>
)
