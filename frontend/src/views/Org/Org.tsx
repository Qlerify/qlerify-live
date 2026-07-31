import { useEffect, useState } from "react"
import { AUTH, api } from "../../lib/api.ts"
import { navigate } from "../../lib/router.ts"
import { useStore } from "../../lib/store.ts"
import type { OrgPortfolio } from "../../lib/types.ts"
import { PanelShell } from "../../components/PanelShell.tsx"
import { NorthStarBand } from "./NorthStarBand.tsx"
import { WorkflowCard } from "./WorkflowCard.tsx"
import { TimelinessPanel } from "./TimelinessPanel.tsx"
import { ValueAtRiskPanel } from "./ValueAtRiskPanel.tsx"
import { AiActivityPanel } from "./AiActivityPanel.tsx"
import { FreshnessPanel } from "./FreshnessPanel.tsx"
import { AssistantButton } from "../../shell/AssistantButton.tsx"
import { AttributeMapDialog } from "./AttributeMapDialog.tsx"

const POLL_MS = 5000

export const Org = () => {
  const { me, set } = useStore()
  const [org, setOrg] = useState<OrgPortfolio | null>(null)
  const [mapOpen, setMapOpen] = useState(false)
  // Re-read on every render so the chip tracks the live breadcrumb selection.
  const focusId = AUTH.workflow() || null

  const load = async () => {
    try {
      setOrg(await api<OrgPortfolio>("/org/portfolio"))
    } catch (e) {
      setOrg({ error: (e as Error).message } as OrgPortfolio)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [])

  // Switch the active workflow (if needed), then drill in.
  const goWorkflow = (workflowId: string, hash = "#") => {
    if (workflowId && workflowId !== AUTH.workflow()) {
      AUTH.setWorkflow(workflowId)
      set({ me: null })
    }
    navigate(hash)
  }

  const clearFocus = () => {
    AUTH.setWorkflow(null)
    set({ me: null })
  }

  const focusName = focusId ? (me?.workflows || []).find((w) => w.id === focusId)?.name || "workflow" : ""

  const header = (right: React.ReactNode) => (
    <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div className="px-6 py-4 flex items-center gap-6">
        <div className="flex-1">
          <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">
            Qlerify Live — Portfolio
          </div>
          <div className="text-stone-900 text-xl font-semibold leading-tight">Portfolio overview</div>
          {focusName && (
            <div className="flex items-center flex-wrap gap-2 mt-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 text-sm">
                Focused: {focusName}
                <button
                  type="button"
                  onClick={clearFocus}
                  title="Clear focus — show all workflows"
                  className="hover:text-amber-700 font-bold leading-none"
                >
                  ✕
                </button>
              </span>
              <button
                type="button"
                onClick={clearFocus}
                className="text-xs text-stone-500 hover:text-stone-800 underline"
              >
                View all
              </button>
            </div>
          )}
          {org && !org.error && (
            <div className="text-xs text-stone-500 mt-0.5">
              {focusId ? "Cards & feeds filtered · KPIs org-wide: " : ""}
              {org.northStar.workflowCount} workflow type{org.northStar.workflowCount === 1 ? "" : "s"} ·{" "}
              {org.northStar.activeInstances} active · {org.northStar.modelledCount} modelled
            </div>
          )}
        </div>
        {right}
      </div>
    </header>
  )

  if (!org || org.error) {
    return (
      <>
        {header(<AssistantButton />)}
        <main className="flex-1 p-6">
          <div className={`text-sm ${org?.error ? "text-rose-600" : "text-stone-400"}`}>
            {org?.error || "Loading portfolio…"}
          </div>
        </main>
        {mapOpen && <AttributeMapDialog onClose={() => setMapOpen(false)} onSaved={load} />}
      </>
    )
  }

  // The focus narrows the per-workflow sections; headline KPIs, timeliness and
  // freshness stay org-wide.
  const wfCards = focusId ? org.workflows.filter((w) => w.id === focusId) : org.workflows
  const exceptions = focusId ? org.exceptions.filter((x) => x.workflowId === focusId) : org.exceptions
  const bottlenecks = focusId ? org.bottlenecks.filter((b) => b.workflowId === focusId) : org.bottlenecks
  const valueAtRisk =
    focusId && org.valueAtRisk?.byWorkflow
      ? { ...org.valueAtRisk, byWorkflow: org.valueAtRisk.byWorkflow.filter((w) => w.workflowId === focusId) }
      : org.valueAtRisk

  const right = (
    <>
      <span className="hidden sm:flex items-center gap-1.5 text-xs text-stone-500">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        live
      </span>
      <button
        onClick={() => setMapOpen(true)}
        title="Map workflow attributes to dashboard capabilities"
        className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
      >
        ⚙ Map attributes
      </button>
      <AssistantButton />
    </>
  )

  return (
    <>
      {header(right)}
      <main className="flex-1 overflow-auto p-6">
        <NorthStarBand ns={org.northStar} />

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <TimelinessPanel
            o={org}
            onOpenMap={() => setMapOpen(true)}
            onGoCase={(wf, caseId) => goWorkflow(wf, `#case/${caseId}`)}
          />
          <ValueAtRiskPanel
            valueAtRisk={valueAtRisk}
            onOpenMap={() => setMapOpen(true)}
            onGoWorkflow={(wf) => goWorkflow(wf)}
          />
        </div>

        <section className="mt-6">
          <div className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold mb-2">
            {focusId ? "Workflow" : "Workflow types"}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {wfCards.length ? (
              wfCards.map((w) => <WorkflowCard key={w.id} w={w} onOpen={() => goWorkflow(w.id)} />)
            ) : (
              <div className="text-sm text-stone-400 col-span-full">No workflow matches this filter.</div>
            )}
          </div>
        </section>

        <section className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <PanelShell eyebrow="Exceptions" title="Cross-portfolio attention queue">
            {exceptions.length ? (
              <div className="-mx-4 -mb-4 divide-y divide-stone-100">
                {exceptions.map((x) => (
                  <button
                    key={`${x.workflowId}-${x.caseId}-${x.kind}`}
                    onClick={() => goWorkflow(x.workflowId, `#case/${x.caseId}`)}
                    className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50"
                  >
                    <span
                      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                        { at_risk: "bg-rose-600", overdue: "bg-rose-500", rework: "bg-rose-400", soft_fail: "bg-stone-400", aging: "bg-amber-400" }[
                          x.kind
                        ] || "bg-stone-400"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-stone-800 truncate">
                        <span className="font-medium">{x.title}</span> — {x.detail}
                      </div>
                      <div className="text-[11px] text-stone-500 truncate">
                        {x.workflowName} · {x.caseId.slice(0, 12)}…
                      </div>
                    </div>
                    <span className="text-[11px] text-stone-400 tabular-nums shrink-0">{x.ageDays}d</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-sm text-stone-400">Nothing needs attention. 🎉</div>
            )}
          </PanelShell>

          <PanelShell eyebrow="Bottlenecks" title="Where work is waiting (by step)">
            {bottlenecks.length ? (
              <div className="-mx-4 -mb-4 divide-y divide-stone-100">
                {bottlenecks.map((b) => (
                  <button
                    key={`${b.workflowId}-${b.stepName}`}
                    onClick={() => goWorkflow(b.workflowId)}
                    className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-stone-800 truncate">
                        {b.stepName} <span className="text-stone-400">· {b.boundedContext}</span>
                      </div>
                      <div className="text-[11px] text-stone-500 truncate">
                        {b.workflowName} · {b.role}
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-stone-700 tabular-nums shrink-0">{b.waiting}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-sm text-stone-400">No active work in flight.</div>
            )}
          </PanelShell>
        </section>

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <AiActivityPanel a={org.aiActivity} />
          <FreshnessPanel f={org.connectorFreshness} />
        </div>
      </main>

      <footer className="px-6 py-3 text-xs text-stone-500 border-t border-stone-200 bg-stone-50">
        <span>Organisation portfolio · computed live from the event log across all workflows.</span>
        <span className="mx-2">·</span>
        <span>updated {new Date(org.generatedAt).toLocaleTimeString()}</span>
      </footer>

      {mapOpen && <AttributeMapDialog onClose={() => setMapOpen(false)} onSaved={load} />}
    </>
  )
}
