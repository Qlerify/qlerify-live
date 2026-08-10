import { useEffect, useMemo, useState } from "react"
import { Loading } from "@/components/Loading.tsx"
import { useStore } from "@/lib/store.ts"
import { navigate, parseHash } from "@/lib/router.ts"
import { prettyEntity } from "@/lib/format.ts"
import { loadTodo, pollOverview } from "@/lib/workflowData.ts"
import { refreshRecs } from "@/lib/todoData.ts"
import { applyQuery, caseRecords, ensureOvScope, fmtStamp, hydrateOv, ovActive, syncOvHash } from "@/lib/ovquery.ts"
import type { NextAction } from "@/lib/types.ts"
import { ViewSwitcher } from "@/shell/ViewSwitcher.tsx"
import { AssistantButton } from "@/shell/AssistantButton.tsx"
import { RolePicker } from "@/shell/RolePicker.tsx"

const POLL_MS = 5000

const actionKey = (caseId: string, eventRef: string) => `${caseId}|${eventRef}`

// One todo row: the Org attention-queue idiom — dot, what/who, case, age.
// `rank`/`aiWhy` decorate the row when the AI ordering is active.
const TodoRow = ({ a, rank, aiWhy }: { a: NextAction; rank?: number; aiWhy?: string }) => (
  <button
    onClick={() => navigate(`#case/${encodeURIComponent(a.caseId)}`)}
    title={aiWhy ? `${aiWhy}\n\n${a.why}` : a.why}
    className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50"
  >
    {rank != null ? (
      <span className="w-5 text-[11px] text-stone-400 tabular-nums text-right shrink-0">{rank}.</span>
    ) : (
      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${a.stale ? "bg-amber-400" : "bg-emerald-400"}`} />
    )}
    <div className="flex-1 min-w-0">
      <div className="text-sm text-stone-800 truncate">
        <span className="font-medium">{a.eventName}</span>
        <span className="text-stone-400"> · {rank != null ? a.role : a.boundedContext}</span>
      </div>
      <div className="text-[11px] text-stone-500 truncate">
        {a.caseId.slice(0, 20)}
        {a.caseId.length > 20 ? "…" : ""} · {aiWhy || a.why}
      </div>
    </div>
    {a.dwellDays != null && (
      <span
        className={`text-[11px] tabular-nums shrink-0 ${a.stale ? "text-amber-700 font-semibold" : "text-stone-400"}`}
        title={a.stale ? "No activity for several days — stale" : "Days since the case's last activity"}
      >
        {a.dwellDays}d
      </span>
    )}
  </button>
)

export const Todo = () => {
  const { nextActions, meta, me, ov, recs, recsBusy } = useStore()
  const plural = prettyEntity(meta.rootAggregatePlural)
  // null = no explicit pick yet → default to my mapped lanes (else all roles);
  // "all" = the user explicitly chose all roles (distinct from null so a
  // mapped user's "All roles" click isn't a no-op back to their own lanes).
  const [roleSel, setRoleSel] = useState<Set<string> | "all" | null>(null)
  // null = auto: AI order when a fresh non-empty ranking exists.
  const [aiPref, setAiPref] = useState<boolean | null>(null)
  const [recsErr, setRecsErr] = useState("")

  useEffect(() => {
    ensureOvScope()
    hydrateOv("todo", parseHash().ovqs || "")
    loadTodo().catch(() => {})
    const t = setInterval(() => {
      pollOverview("todo").catch(() => {})
    }, POLL_MS)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    syncOvHash("todo")
  }, [ov])

  // The shared cross-tab query narrows which CASES feed the list (a region
  // filter carved on the Flow tab carries here); role chips then narrow WHO.
  const records = caseRecords()
  const res = applyQuery(records, "todo")
  const narrowed = ovActive()
  const allowedCases = useMemo(() => (narrowed ? new Set(res.rows.map((r) => r.id)) : null), [narrowed, res.rows])

  if (!nextActions) {
    return <Loading />
  }

  const roles = Object.entries(nextActions.byRole).sort((a, b) => b[1] - a[1])
  const myRoles = (me?.domainRoles || []).filter((r) => r in nextActions.byRole)
  const active =
    roleSel === "all" ? null : (roleSel ?? (myRoles.length ? new Set(myRoles) : null)) // null = all
  const isOn = (role: string) => !active || active.has(role)

  const toggleRole = (role: string) => {
    if (active?.has(role) && active.size === 1) {
      setRoleSel("all") // deselecting the last chip = explicitly all
      return
    }
    if (!active) {
      // From "all", a click focuses that one role.
      setRoleSel(new Set([role]))
      return
    }
    const cur = new Set(active)
    if (cur.has(role)) {
      cur.delete(role)
    } else {
      cur.add(role)
    }
    setRoleSel(cur)
  }

  const visible = nextActions.actions.filter((a) => isOn(a.role) && (!allowedCases || allowedCases.has(a.caseId)))
  const hiddenByRole = nextActions.actions.filter((a) => !isOn(a.role) && (!allowedCases || allowedCases.has(a.caseId)))
  const byRole = new Map<string, NextAction[]>()
  for (const a of visible) {
    const arr = byRole.get(a.role)
    if (arr) {
      arr.push(a)
    } else {
      byRole.set(a.role, [a])
    }
  }
  const groups = [...byRole.entries()].sort((x, y) => y[1].length - x[1].length)
  const visibleCases = new Set(visible.map((a) => a.caseId)).size

  // --- AI ranking overlay ---------------------------------------------------
  const stored = recs?.recs ?? null
  const hasRanking = !!stored && stored.items.length > 0
  const aiOrder = aiPref ?? (recs?.status === "fresh" && hasRanking)
  const visibleByKey = new Map(visible.map((a) => [actionKey(a.caseId, a.eventRef), a]))
  const ranked = hasRanking
    ? stored.items
        .map((i) => ({ item: i, action: visibleByKey.get(actionKey(i.caseId, i.eventRef)) }))
        .filter((x): x is { item: (typeof stored.items)[number]; action: NextAction } => !!x.action)
    : []
  const rankedKeys = new Set(ranked.map((x) => actionKey(x.action.caseId, x.action.eventRef)))
  const unranked = visible.filter((a) => !rankedKeys.has(actionKey(a.caseId, a.eventRef)))

  const doRefresh = async () => {
    setRecsErr("")
    const err = await refreshRecs()
    if (err) {
      setRecsErr(err)
    }
  }

  // "No todos for your roles" is a routing insight — name where the work waits.
  const waitingOn = [...new Set(hiddenByRole.map((a) => a.role))].slice(0, 3)

  return (
    <>
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="px-6 py-4 flex items-center gap-6">
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">
              {meta.title} — to do
            </div>
            <div className="text-stone-900 text-xl font-semibold leading-tight">What to do next</div>
            <div className="text-[12px] text-stone-500 mt-0.5 tabular-nums">
              {visible.length} open step{visible.length === 1 ? "" : "s"} across {visibleCases}{" "}
              {visibleCases === 1 ? meta.rootAggregate.toLowerCase() : plural.toLowerCase()}
              {narrowed && (
                <span className="text-amber-700"> · filtered — {res.total} of {records.length} cases match</span>
              )}
            </div>
          </div>
          <RolePicker />
          <ViewSwitcher active="todo" />
          <AssistantButton />
        </div>
        <div className="px-6 pb-3 flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setRoleSel("all")}
            className={`px-2.5 py-1 text-[12px] rounded-full border ${!active ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"}`}
            title="Show every role's todos"
          >
            All roles
          </button>
          {roles.map(([role, n]) => (
            <button
              key={role}
              onClick={() => toggleRole(role)}
              className={`px-2.5 py-1 text-[12px] rounded-full border tabular-nums ${active?.has(role) ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"}`}
              title={`${n} open step${n === 1 ? "" : "s"} owned by ${role}${myRoles.includes(role) ? " (one of your roles)" : ""}`}
            >
              {role} · {n}
              {myRoles.includes(role) && <span className="ml-1 opacity-70">★</span>}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-auto p-6 space-y-4">
        <section className="rounded-lg border border-stone-200 bg-white px-4 py-3 flex items-start gap-3">
          <div className="flex-1 min-w-0 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">
                AI recommendations
              </span>
              {recs?.status === "fresh" && stored && (
                <span className="text-[11px] px-1.5 py-px rounded bg-emerald-100 text-emerald-800">up to date</span>
              )}
              {recs?.status === "stale" && (
                <span
                  className="text-[11px] px-1.5 py-px rounded bg-amber-100 text-amber-800"
                  title="The model or the case data changed since this ranking was generated. The order below may be outdated — refresh to re-rank."
                >
                  model or data changed since this ranking — refresh
                </span>
              )}
              {!!recs?.dropped && (
                <span className="text-[11px] text-stone-400" title="Ranked steps that have since fired or been bypassed — progress since the last ranking.">
                  {recs.dropped} completed since
                </span>
              )}
            </div>
            {stored?.summary && <p className="text-stone-600 mt-1">{stored.summary}</p>}
            {stored ? (
              <div className="text-[11px] text-stone-400 mt-1">
                Generated {fmtStamp(stored.generatedAt)}
                {stored.llmModel ? ` · ${stored.llmModel}` : ""}
              </div>
            ) : (
              <p className="text-stone-500 mt-1">
                Rank the open steps by business urgency — the AI orders the deterministic list below and adds a
                one-line why per step. It never invents steps: only what the model says can happen next.
              </p>
            )}
            {recsErr && <p className="text-rose-700 mt-1">{recsErr}</p>}
          </div>
          {hasRanking && (
            <div
              className="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-stone-300 bg-stone-100 text-[12px] shrink-0"
              role="group"
              aria-label="Ordering"
            >
              <button
                onClick={() => setAiPref(false)}
                className={`px-2 py-1 rounded ${!aiOrder ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"}`}
                title="Group by the role that owns each step, stalest first"
              >
                By role
              </button>
              <button
                onClick={() => setAiPref(true)}
                className={`px-2 py-1 rounded ${aiOrder ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"}`}
                title="One list in the AI's recommended order"
              >
                AI order
              </button>
            </div>
          )}
          <button
            onClick={doRefresh}
            disabled={recsBusy}
            className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 shrink-0"
            title="Generate a fresh AI ranking of the current open steps (uses the organization's AI provider)"
          >
            {recsBusy ? "Ranking…" : stored ? "Refresh" : "Generate"}
          </button>
        </section>

        {visible.length === 0 && (
          <div className="rounded-lg border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
            {nextActions.totalActions === 0 ? (
              <>All caught up — no open next steps in any {meta.rootAggregate.toLowerCase()}. 🎉</>
            ) : waitingOn.length ? (
              <>
                No todos for the selected roles — {hiddenByRole.length} open step
                {hiddenByRole.length === 1 ? "" : "s"} wait on <b>{waitingOn.join(", ")}</b>.
              </>
            ) : (
              <>No todos match the current filter — clear it in another tab or widen the slice.</>
            )}
          </div>
        )}

        {aiOrder && visible.length > 0 ? (
          <>
            <section className="rounded-lg border border-stone-200 bg-white overflow-hidden">
              <div className="px-4 py-2 border-b border-stone-200 bg-stone-50 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">
                  AI-recommended order
                </span>
                <span className="ml-auto text-[11px] text-stone-400 tabular-nums">
                  {ranked.length} ranked step{ranked.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="divide-y divide-stone-100">
                {ranked.map(({ item, action }) => (
                  <TodoRow key={actionKey(action.caseId, action.eventRef)} a={action} rank={item.priority} aiWhy={item.why} />
                ))}
              </div>
            </section>
            {unranked.length > 0 && (
              <section className="rounded-lg border border-stone-200 bg-white overflow-hidden">
                <div className="px-4 py-2 border-b border-stone-200 bg-stone-50">
                  <span
                    className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold"
                    title="Open steps the last AI pass didn't rank (they appeared after it ran, or fell outside its window) — shown stalest first."
                  >
                    Not ranked yet — stalest first
                  </span>
                </div>
                <div className="divide-y divide-stone-100">
                  {unranked.map((a) => (
                    <TodoRow key={actionKey(a.caseId, a.eventRef)} a={a} />
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          groups.map(([role, actions]) => (
            <section key={role} className="rounded-lg border border-stone-200 bg-white overflow-hidden">
              <div className="px-4 py-2 border-b border-stone-200 bg-stone-50 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">{role}</span>
                {myRoles.includes(role) && (
                  <span className="text-[10px] px-1.5 py-px rounded bg-stone-200 text-stone-600" title="You are mapped to this role">
                    you
                  </span>
                )}
                <span className="ml-auto text-[11px] text-stone-400 tabular-nums">
                  {actions.length} step{actions.length === 1 ? "" : "s"} · {new Set(actions.map((a) => a.caseId)).size}{" "}
                  {plural.toLowerCase()}
                </span>
              </div>
              <div className="divide-y divide-stone-100">
                {actions.map((a) => (
                  <TodoRow key={actionKey(a.caseId, a.eventRef)} a={a} />
                ))}
              </div>
            </section>
          ))
        )}

        <p className="text-sm text-stone-500 max-w-3xl">
          Every unblocked step across all open {plural.toLowerCase()}, grouped by the role that owns it — stalest
          first. A step appears the moment its predecessor fires and disappears when it (or anything after it)
          happens. Click a row to open the {meta.rootAggregate.toLowerCase()} and act on it.
        </p>
      </main>
    </>
  )
}
