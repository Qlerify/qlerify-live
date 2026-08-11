import { MiniStat, PanelShell } from "@/components/PanelShell.tsx"
import type { OrgPortfolio } from "@/lib/types.ts"

export const AiActivityPanel = ({ a }: { a: OrgPortfolio["aiActivity"] }) => {
  if (!a) {
    return null
  }

  if (!a.live) {
    return (
      <PanelShell eyebrow="AI activity & trust" title="Autonomy · override · guardrails">
        <div className="text-sm text-stone-400">{a.note}</div>
      </PanelShell>
    )
  }

  const s = a.aiActionShare
  const aiPct = s.pct ?? 0
  const humanPct = s.pct != null ? 100 - s.pct : 0

  return (
    <PanelShell eyebrow="AI activity & trust" title="Autonomy · override · guardrails">
      <div>
        <div className="flex justify-between text-xs text-stone-600">
          <span>Autonomy mix</span>
          <span className="tabular-nums">{s.pct != null ? `${s.pct}% AI` : "—"}</span>
        </div>
        <div
          className="mt-1 h-2.5 bg-stone-100 rounded overflow-hidden flex"
          title={`${s.ai} AI · ${s.human} human state-changing events`}
        >
          <div className="bg-violet-500" style={{ width: `${aiPct}%` }} />
          <div className="bg-stone-300" style={{ width: `${humanPct}%` }} />
        </div>
        <div className="flex gap-3 pt-1 text-[10px] text-stone-500">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-violet-500" />
            AI {s.ai}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-stone-300" />
            Human {s.human}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <MiniStat
          label="Override rate"
          value={a.override.pct != null ? `${a.override.pct}%` : "—"}
          tone={(a.override.pct ?? 0) > 0 ? "text-amber-700" : "text-stone-900"}
        />
        <MiniStat
          label="Guardrail blocks"
          value={a.guardrail.pct != null ? `${a.guardrail.pct}%` : "—"}
          tone={a.guardrail.aiBlocked > 0 ? "text-rose-700" : "text-stone-900"}
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3 text-[10px] text-stone-500 text-center">
        <div>
          {a.override.overridden}/{a.override.aiEvents} AI events corrected
        </div>
        <div>
          {a.guardrail.aiBlocked}/{a.guardrail.aiAttempts} AI writes denied
        </div>
      </div>

      {a.note && <div className="mt-3 text-xs text-stone-500">{a.note}</div>}
    </PanelShell>
  )
}
