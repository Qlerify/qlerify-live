// Organisation portfolio dashboard (#org) — cross-workflow control tower.
// Extracted from app.js; shared services imported from ./app.js.
import { state } from "./state.js";
import { escapeHtml } from "./format.js";
import { PROV_STYLE } from "./chips.js";
import { AUTH, api, ensureMe, navigate, render } from "./app.js";

// ===========================================================================
// Organisation portfolio dashboard (#org) — the tier ABOVE the per-workflow
// overview. Spans every workflow TYPE in the org. Built from /org/portfolio
// (one cross-workflow aggregation over the event log). Capability-gating: panels
// that need a mapped attribute (e.g. a commitment date) render ready / partial /
// locked and link to the attribute-mapping dialog.
// ===========================================================================

export async function loadOrg() {
  state.orgBusy = true;
  try {
    state.org = await api("/org/portfolio");
  } catch (e) {
    state.org = { error: e.message };
  } finally {
    state.orgBusy = false;
    render();
  }
}

// Switch the active workflow (if needed) then navigate — the drill from a
// portfolio tile into that workflow's overview or one of its instances.
export async function orgGotoWorkflow(workflowId, hash) {
  if (workflowId && workflowId !== AUTH.workflow()) {
    AUTH.setWorkflow(workflowId);
    state.me = null;
    await ensureMe();
  }
  navigate(hash || "#");
}

// --- North-star band helpers ---
export function orgTile(label, big, sub, opts = {}) {
  return `
    <div class="rounded-lg border border-stone-200 bg-white p-4">
      <div class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">${escapeHtml(label)}</div>
      <div class="mt-1 text-2xl font-semibold tabular-nums leading-none ${opts.tone || "text-stone-900"}">${escapeHtml(String(big))}</div>
      ${sub ? `<div class="mt-1 text-xs text-stone-500">${escapeHtml(sub)}</div>` : ""}
      ${opts.spark || ""}
    </div>`;
}
export function orgSpark(series) {
  const max = Math.max(1, ...series.map((s) => s.count));
  const bars = series.map((s) => {
    const h = Math.max(2, Math.round((s.count / max) * 24));
    return `<div class="flex-1 bg-amber-300/80 rounded-sm" style="height:${h}px" title="${escapeHtml(s.week)}: ${s.count}"></div>`;
  }).join("");
  return `<div class="mt-2 flex items-end gap-0.5 h-6">${bars}</div>`;
}
// Per-workflow twin-trust chip — colour follows the provenance ladder.
export function provTrustChip(tp) {
  const mode = tp.pct >= 50 ? "live" : tp.pct > 0 ? "recorded" : "simulated";
  const s = PROV_STYLE[mode] || PROV_STYLE.simulated;
  return `<span class="text-[9px] font-semibold px-1 py-px rounded ${s.chip}" title="${tp.real}/${tp.total} events from a real source">${tp.pct}% real</span>`;
}
export function panelShell(eyebrow, title, body) {
  return `
    <section class="rounded-lg border border-stone-200 bg-white overflow-hidden">
      <div class="px-4 py-3 border-b border-stone-100">
        <div class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">${escapeHtml(eyebrow)}</div>
        <div class="text-sm font-semibold text-stone-800">${escapeHtml(title)}</div>
      </div>
      <div class="p-4">${body}</div>
    </section>`;
}
export function orgMiniStat(label, value, tone) {
  return `<div class="rounded-md border border-stone-200 bg-stone-50 p-3 text-center"><div class="text-xl font-semibold tabular-nums ${tone || "text-stone-900"}">${value}</div><div class="text-[10px] uppercase tracking-wide text-stone-500 mt-0.5">${escapeHtml(label)}</div></div>`;
}

// --- Timeliness panel: the capability-GATED demonstration. Renders locked /
// partial / ready off the commitDate capability's mapping coverage. ---
export function orgTimelinessPanel(o) {
  const cap = (o.capabilities || []).find((c) => c.key === "commitDate");
  if (!cap) return "";
  if (cap.state === "locked") {
    return panelShell("Timeliness", "Overdue & on-time commitments", `
      <div class="flex items-center gap-4 rounded-md border border-dashed border-stone-300 bg-stone-50 p-4">
        <div class="text-2xl">🔒</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-stone-700">This panel needs a commitment / due date</div>
          <div class="text-xs text-stone-500 mt-0.5">${escapeHtml(cap.description)}</div>
        </div>
        <button data-org-map-open class="shrink-0 px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Map attributes →</button>
      </div>`);
  }
  const t = o.timeliness || { overdue: 0, predictedLate: 0, onTime: 0, scorable: 0, rows: [], partial: null };
  const partialNote = t.partial
    ? `<div class="mb-3 flex items-center gap-1.5 flex-wrap text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">⚠ ${t.partial.unmapped.length} workflow${t.partial.unmapped.length === 1 ? "" : "s"} not mapped yet — <button data-org-map-open class="underline font-medium">map ${t.partial.unmapped.length === 1 ? "it" : "them"}</button> to include their commitments.</div>`
    : "";
  const rows = (t.rows || []).map((r) => {
    const late = r.kind === "overdue";
    const sub = late ? `due ${escapeHtml(r.dueDate)}` : `due ${escapeHtml(r.dueDate)} · projected ${escapeHtml(r.predictedFinish || "—")}`;
    return `
    <button data-ex-go="${r.workflowId}|${r.caseId}" class="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50">
      <span class="inline-block w-2 h-2 rounded-full ${late ? "bg-rose-500" : "bg-amber-400"} shrink-0"></span>
      <div class="flex-1 min-w-0"><div class="text-sm text-stone-800 truncate">${escapeHtml(r.workflowName)} · ${escapeHtml(r.caseId.slice(0, 12))}…</div><div class="text-[11px] text-stone-500">${sub}</div></div>
      <span class="text-[11px] font-medium ${late ? "text-rose-700" : "text-amber-700"} tabular-nums shrink-0">${late ? r.days + "d late" : "~" + r.days + "d slip"}</span>
    </button>`;
  }).join("");
  return panelShell("Timeliness", "Overdue, predicted-late & on-time commitments", `
    ${partialNote}
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      ${orgMiniStat("Overdue", t.overdue, "text-rose-700")}
      ${orgMiniStat("Predicted late", t.predictedLate ?? 0, "text-amber-700")}
      ${orgMiniStat("On time", t.onTime, "text-emerald-700")}
      ${orgMiniStat("Scorable", t.scorable, "text-stone-700")}
    </div>
    ${rows ? `<div class="mt-3 divide-y divide-stone-100 rounded-md border border-stone-200 overflow-hidden">${rows}</div>` : `<div class="mt-3 text-sm text-stone-400">No overdue or predicted-late commitments. 🎉</div>`}
  `);
}

// --- Portfolio grid card (one per workflow TYPE) ---
export function orgCard(w) {
  if (!w.hasModel) {
    return `<button data-wf-go="${w.id}" class="text-left rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 hover:border-stone-400 transition">
      <div class="font-semibold text-stone-700 truncate">${escapeHtml(w.name)}</div>
      <div class="text-xs text-stone-500 mt-1">No model yet — open to set one.</div>
    </button>`;
  }
  const role = w.topRoleQueue, oldest = w.oldestActive;
  const chips = (w.atRisk || w.reworkCount || w.softFailCount)
    ? `<div class="flex gap-1.5 pt-1 flex-wrap">${w.atRisk ? `<span class="px-1.5 py-px rounded bg-rose-200 text-rose-800 text-[11px] font-medium">${w.atRisk} at risk</span>` : ""}${w.reworkCount ? `<span class="px-1.5 py-px rounded bg-rose-100 text-rose-700 text-[11px]">${w.reworkCount} rework</span>` : ""}${w.softFailCount ? `<span class="px-1.5 py-px rounded bg-stone-200 text-stone-600 text-[11px]">${w.softFailCount} soft-fail</span>` : ""}</div>`
    : "";
  const cycleLine = w.cycleIndex != null
    ? `<div class="flex justify-between gap-2"><span class="text-stone-500">Cycle time</span><span class="font-medium ${w.cycleIndex > 1.2 ? "text-amber-700" : "text-stone-700"}">${w.cycleIndex}× vs plan${w.expectedDays != null ? ` · ~${w.expectedDays}d` : ""}</span></div>`
    : "";
  return `
    <button data-wf-go="${w.id}" class="text-left rounded-lg border border-stone-200 bg-white p-4 hover:border-amber-300 hover:shadow-sm transition">
      <div class="flex items-center justify-between gap-2">
        <div class="font-semibold text-stone-900 truncate">${escapeHtml(w.name)}</div>
        ${provTrustChip(w.twinTrust)}
      </div>
      <div class="mt-3 grid grid-cols-3 gap-2 text-center">
        <div><div class="text-xl font-semibold text-stone-900 tabular-nums">${w.active}</div><div class="text-[10px] uppercase text-stone-500">active</div></div>
        <div><div class="text-xl font-semibold text-stone-900 tabular-nums">${w.completed}</div><div class="text-[10px] uppercase text-stone-500">done</div></div>
        <div><div class="text-xl font-semibold text-stone-900 tabular-nums">${w.throughputRecent}</div><div class="text-[10px] uppercase text-stone-500">8wk</div></div>
      </div>
      <div class="mt-3 space-y-1 text-xs text-stone-600">
        ${role ? `<div class="flex justify-between gap-2"><span class="text-stone-500">Top queue</span><span class="font-medium truncate">${escapeHtml(role.role)} · ${role.count}</span></div>` : ""}
        ${cycleLine}
        ${oldest ? `<div class="flex justify-between gap-2"><span class="text-stone-500">Oldest active</span><span class="font-medium truncate">${escapeHtml(oldest.stepName)} · ${oldest.ageDays}d</span></div>` : ""}
        ${chips}
      </div>
      <div class="mt-2 text-[10px] text-stone-400">${w.totalSteps} steps</div>
    </button>`;
}

export function orgExceptionRow(x) {
  const dot = { at_risk: "bg-rose-600", overdue: "bg-rose-500", rework: "bg-rose-400", soft_fail: "bg-stone-400", aging: "bg-amber-400" }[x.kind] || "bg-stone-400";
  return `
    <button data-ex-go="${x.workflowId}|${x.caseId}" class="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50">
      <span class="inline-block w-2 h-2 rounded-full ${dot} shrink-0"></span>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-stone-800 truncate"><span class="font-medium">${escapeHtml(x.title)}</span> — ${escapeHtml(x.detail)}</div>
        <div class="text-[11px] text-stone-500 truncate">${escapeHtml(x.workflowName)} · ${escapeHtml(x.caseId.slice(0, 12))}…</div>
      </div>
      <span class="text-[11px] text-stone-400 tabular-nums shrink-0">${x.ageDays}d</span>
    </button>`;
}
export function orgBottleneckRow(b) {
  return `
    <button data-bn-go="${b.workflowId}" class="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50">
      <div class="flex-1 min-w-0">
        <div class="text-sm text-stone-800 truncate">${escapeHtml(b.stepName)} <span class="text-stone-400">· ${escapeHtml(b.boundedContext)}</span></div>
        <div class="text-[11px] text-stone-500 truncate">${escapeHtml(b.workflowName)} · ${escapeHtml(b.role)}</div>
      </div>
      <span class="text-sm font-semibold text-stone-700 tabular-nums shrink-0">${b.waiting}</span>
    </button>`;
}

// --- Value at risk (days-first cost-of-delay) ---
export function orgValueAtRiskPanel(o) {
  const v = o.valueAtRisk;
  if (!v) return "";
  const stats = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      ${orgMiniStat("Days at risk", v.totalDays, v.totalDays > 0 ? "text-rose-700" : "text-stone-900")}
      ${orgMiniStat("Overdue", v.overdueDays, "text-rose-700")}
      ${orgMiniStat("Projected slip", v.slipDays, "text-amber-700")}
      ${orgMiniStat("Over-run", v.overrunDays, "text-stone-700")}
    </div>`;
  const note = !v.hasCommitData
    ? `<div class="mt-3 text-xs text-stone-500">Overdue & projected-slip days need a commitment date — <button data-org-map-open class="underline font-medium">map one</button>. Over-run days come from the derived baseline.</div>`
    : "";
  const max = Math.max(1, ...(v.byWorkflow || []).map((w) => w.totalDays));
  const bars = (v.byWorkflow || []).length
    ? `<div class="mt-3 space-y-2">${v.byWorkflow.map((w) => `
        <button data-wf-go="${w.workflowId}" class="w-full text-left">
          <div class="flex justify-between text-xs"><span class="text-stone-700 truncate">${escapeHtml(w.workflowName)}</span><span class="font-medium text-stone-700 tabular-nums">${w.totalDays}d</span></div>
          <div class="mt-0.5 h-2 bg-stone-100 rounded overflow-hidden flex">
            <div class="bg-rose-500" style="width:${(w.overdueDays / max) * 100}%" title="${w.overdueDays}d overdue"></div>
            <div class="bg-amber-400" style="width:${(w.slipDays / max) * 100}%" title="${w.slipDays}d projected slip"></div>
            <div class="bg-stone-400" style="width:${(w.overrunDays / max) * 100}%" title="${w.overrunDays}d over-run"></div>
          </div>
        </button>`).join("")}
        <div class="flex gap-3 pt-1 text-[10px] text-stone-500"><span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm bg-rose-500"></span>overdue</span><span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm bg-amber-400"></span>slip</span><span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm bg-stone-400"></span>over-run</span></div>
      </div>`
    : `<div class="mt-3 text-sm text-stone-400">No days at risk. 🎉</div>`;
  return panelShell("Value at risk", "Cost of delay, in days", `${stats}${note}${bars}`);
}

// --- Connector freshness strip (PREVIEW: static placeholder until real wiring) ---
export function orgFreshnessPanel(o) {
  const f = o.connectorFreshness;
  if (!f) return "";
  const badge = f.preview ? `<span class="text-[10px] uppercase font-semibold px-1.5 py-px rounded bg-amber-100 text-amber-800" title="Sample data — not yet wired to live connectors">preview</span>` : "";
  const chips = (f.sources || []).map((s) => {
    const tone = s.status === "ok" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : s.status === "stale" ? "bg-rose-50 text-rose-700 border-rose-200"
      : "bg-stone-50 text-stone-500 border-stone-200";
    const dot = s.status === "ok" ? "bg-emerald-500" : s.status === "stale" ? "bg-rose-500" : "bg-stone-400";
    return `<button data-sys class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border ${tone} text-xs" title="SLA ${s.slaMinutes}m · ${s.status}">
      <span class="inline-block w-1.5 h-1.5 rounded-full ${dot}"></span>
      <span class="font-medium">${escapeHtml(s.name)}</span>
      <span class="opacity-70">${escapeHtml(s.lastEventAgo)}</span>
    </button>`;
  }).join("");
  return `
    <section class="rounded-lg border border-stone-200 bg-white overflow-hidden">
      <div class="px-4 py-3 border-b border-stone-100 flex items-center gap-2">
        <div class="flex-1"><div class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">Connector freshness</div><div class="text-sm font-semibold text-stone-800">Source-system sync health</div></div>
        ${badge}
      </div>
      <div class="p-4">
        <div class="flex flex-wrap gap-2">${chips}</div>
        ${f.note ? `<div class="mt-3 text-xs text-stone-500">${escapeHtml(f.note)}</div>` : ""}
      </div>
    </section>`;
}

// --- AI Activity & Trust — live, from the EventLog actorKind stamp + PDP audit
// log (no longer "needs instrumentation"). Autonomy mix, override, guardrails. ---
export function orgAiActivityPanel(o) {
  const a = o.aiActivity;
  if (!a) return "";
  if (!a.live) {
    return panelShell("AI activity & trust", "Autonomy · override · guardrails",
      `<div class="text-sm text-stone-400">${escapeHtml(a.note)}</div>`);
  }
  const s = a.aiActionShare;
  const aiPct = s.pct ?? 0;
  const humanPct = s.pct != null ? 100 - s.pct : 0;
  const mix = `
    <div>
      <div class="flex justify-between text-xs text-stone-600"><span>Autonomy mix</span><span class="tabular-nums">${s.pct != null ? s.pct + "% AI" : "—"}</span></div>
      <div class="mt-1 h-2.5 bg-stone-100 rounded overflow-hidden flex" title="${s.ai} AI · ${s.human} human state-changing events">
        <div class="bg-violet-500" style="width:${aiPct}%"></div>
        <div class="bg-stone-300" style="width:${humanPct}%"></div>
      </div>
      <div class="flex gap-3 pt-1 text-[10px] text-stone-500">
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm bg-violet-500"></span>AI ${s.ai}</span>
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm bg-stone-300"></span>Human ${s.human}</span>
      </div>
    </div>`;
  const stats = `
    <div class="grid grid-cols-2 gap-3 mt-3">
      ${orgMiniStat("Override rate", a.override.pct != null ? a.override.pct + "%" : "—", a.override.pct > 0 ? "text-amber-700" : "text-stone-900")}
      ${orgMiniStat("Guardrail blocks", a.guardrail.pct != null ? a.guardrail.pct + "%" : "—", a.guardrail.aiBlocked > 0 ? "text-rose-700" : "text-stone-900")}
    </div>
    <div class="mt-2 grid grid-cols-2 gap-3 text-[10px] text-stone-500 text-center">
      <div>${a.override.overridden}/${a.override.aiEvents} AI events corrected</div>
      <div>${a.guardrail.aiBlocked}/${a.guardrail.aiAttempts} AI writes denied</div>
    </div>`;
  const note = a.note ? `<div class="mt-3 text-xs text-stone-500">${escapeHtml(a.note)}</div>` : "";
  return panelShell("AI activity & trust", "Autonomy · override · guardrails", `${mix}${stats}${note}`);
}

// The currently-focused workflow's name, when one is selected. Derived from the
// live selection (AUTH.workflow) so it stays in sync with the breadcrumb and
// survives a Back into that workflow.
export function orgFilterLabel() {
  const id = AUTH.workflow();
  if (!id) return "";
  return (state.me?.workflows || []).find((w) => w.id === id)?.name || "workflow";
}

// "Focused: …" — not "Showing:". The focus narrows the per-workflow sections
// (cards, exceptions, bottlenecks, value-at-risk) while the headline KPIs,
// timeliness and freshness stay org-wide, so the label must not claim a full
// filter. The chip's ✕ / "View all" clear the focus (deselect the workflow).
export function orgFilterChip() {
  const name = orgFilterLabel();
  if (!name) return "";
  return `
    <div class="flex items-center flex-wrap gap-2 mt-2">
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 text-sm">
        Focused: ${escapeHtml(name)}
        <button id="org-filter-clear" type="button" class="hover:text-amber-700 font-bold leading-none" title="Clear focus — show all workflows">✕</button>
      </span>
      <button id="org-filter-view-all" type="button" class="text-xs text-stone-500 hover:text-stone-800 underline">View all</button>
    </div>`;
}

export function orgView() {
  const o = state.org;
  const fid = AUTH.workflow() || null;
  const head = (right) => `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Qlerify Live — Portfolio</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">Portfolio overview</div>
          ${orgFilterChip()}
          ${o && !o.error ? `<div class="text-xs text-stone-500 mt-0.5">${fid ? "Cards &amp; feeds filtered · KPIs org-wide: " : ""}${o.northStar.workflowCount} workflow type${o.northStar.workflowCount === 1 ? "" : "s"} · ${o.northStar.activeInstances} active · ${o.northStar.modelledCount} modelled</div>` : ""}
        </div>
        ${right}
      </div>
    </header>`;
  const assistantBtn = `<button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>`;

  if (!o || o.error) {
    return head(assistantBtn) + `<main class="flex-1 p-6"><div class="text-sm ${o && o.error ? "text-rose-600" : "text-stone-400"}">${o && o.error ? escapeHtml(o.error) : "Loading portfolio…"}</div></main>` + orgMapDialog();
  }
  const ns = o.northStar;
  const wfCards = fid ? o.workflows.filter((w) => w.id === fid) : o.workflows;
  const exceptions = fid ? o.exceptions.filter((x) => x.workflowId === fid) : o.exceptions;
  const bottlenecks = fid ? o.bottlenecks.filter((b) => b.workflowId === fid) : o.bottlenecks;
  const valueAtRisk = fid && o.valueAtRisk?.byWorkflow
    ? { ...o.valueAtRisk, byWorkflow: o.valueAtRisk.byWorkflow.filter((w) => w.workflowId === fid) }
    : o.valueAtRisk;
  const oPanels = valueAtRisk !== o.valueAtRisk ? { ...o, valueAtRisk } : o;
  const right = `
    <span class="hidden sm:flex items-center gap-1.5 text-xs text-stone-500"><span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>live</span>
    <button data-org-map-open class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50" title="Map workflow attributes to dashboard capabilities">⚙ Map attributes</button>
    ${assistantBtn}`;
  const flowTone = ns.flowRatio != null && ns.flowRatio < 1 ? "text-amber-700" : "text-stone-900";
  const atRiskTone = ns.atRisk > 0 ? "text-rose-700" : "text-stone-900";
  const band = `
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      ${orgTile("Active instances", ns.activeInstances, `${ns.totalInstances} total · ${ns.completedInstances} done`)}
      ${orgTile("At risk", ns.atRisk, ns.cycleIndex != null ? `cycle ${ns.cycleIndex}× vs plan` : "beyond own history", { tone: atRiskTone })}
      ${orgTile("Throughput · 8 wk", ns.completedRecent, "completed", { spark: orgSpark(ns.throughputSeries) })}
      ${orgTile("Flow ratio", ns.flowRatio != null ? ns.flowRatio + "×" : "—", "completed ÷ started", { tone: flowTone })}
      ${orgTile("Twin trust", ns.twinTrust.pct + "%", `${ns.twinTrust.real}/${ns.twinTrust.total} events real`)}
      ${orgTile("Data conformance", ns.conformance.pct + "%", `${ns.conformance.clean}/${ns.conformance.total} clean steps`)}
    </div>`;
  const grid = `
    <section class="mt-6">
      <div class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold mb-2">${fid ? "Workflow" : "Workflow types"}</div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">${wfCards.length ? wfCards.map(orgCard).join("") : `<div class="text-sm text-stone-400 col-span-full">No workflow matches this filter.</div>`}</div>
    </section>`;
  const feeds = `
    <section class="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
      ${panelShell("Exceptions", "Cross-portfolio attention queue", exceptions.length ? `<div class="-mx-4 -mb-4 divide-y divide-stone-100">${exceptions.map(orgExceptionRow).join("")}</div>` : `<div class="text-sm text-stone-400">Nothing needs attention. 🎉</div>`)}
      ${panelShell("Bottlenecks", "Where work is waiting (by step)", bottlenecks.length ? `<div class="-mx-4 -mb-4 divide-y divide-stone-100">${bottlenecks.map(orgBottleneckRow).join("")}</div>` : `<div class="text-sm text-stone-400">No active work in flight.</div>`)}
    </section>`;
  return head(right) + `
    <main class="flex-1 overflow-auto p-6">
      ${band}
      <div class="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
        ${orgTimelinessPanel(o)}
        ${orgValueAtRiskPanel(oPanels)}
      </div>
      ${grid}
      ${feeds}
      <div class="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
        ${orgAiActivityPanel(o)}
        ${orgFreshnessPanel(o)}
      </div>
    </main>
    <footer class="px-6 py-3 text-xs text-stone-500 border-t border-stone-200 bg-stone-50">
      <span>Organisation portfolio · computed live from the event log across all workflows.</span>
      <span class="mx-2">·</span><span>updated ${escapeHtml(new Date(o.generatedAt).toLocaleTimeString())}</span>
    </footer>` + orgMapDialog();
}

export function bindOrg() {
  // "View all" / ✕ — clear the focus (deselect the workflow) so the portfolio
  // spans every workflow and the breadcrumb reads "All workflows". Portfolio
  // data is org-wide regardless, so no refetch is needed — just re-render.
  const clearOrgFilter = () => { AUTH.setWorkflow(null); render(); };
  document.getElementById("org-filter-clear")?.addEventListener("click", clearOrgFilter);
  document.getElementById("org-filter-view-all")?.addEventListener("click", clearOrgFilter);
  document.querySelectorAll("[data-wf-go]").forEach((el) => el.addEventListener("click", () => orgGotoWorkflow(el.getAttribute("data-wf-go"), "#")));
  document.querySelectorAll("[data-bn-go]").forEach((el) => el.addEventListener("click", () => orgGotoWorkflow(el.getAttribute("data-bn-go"), "#")));
  document.querySelectorAll("[data-ex-go]").forEach((el) => el.addEventListener("click", () => {
    const [wf, caseId] = (el.getAttribute("data-ex-go") || "").split("|");
    orgGotoWorkflow(wf, `#case/${caseId}`);
  }));
  document.querySelectorAll("[data-sys]").forEach((el) => el.addEventListener("click", () => navigate("#bcs")));
  document.querySelectorAll("[data-org-map-open]").forEach((el) => el.addEventListener("click", openOrgMap));
  bindOrgMap();
}

// --- Attribute-mapping dialog (the heart of capability-gating) ---
export async function openOrgMap() {
  state.orgMapOpen = true; state.orgMapErr = null; state.orgMap = null;
  render();
  try { state.orgMap = await api("/org/mappings"); }
  catch (e) { state.orgMap = { error: e.message }; }
  render();
}

export async function orgSaveMapping(workflowId, capabilityKey, field) {
  state.orgMapBusy = true; state.orgMapErr = null; render();
  try {
    const res = await api(`/org/mappings/${workflowId}`, { method: "PUT", body: JSON.stringify({ capabilityKey, field: field || null }) });
    const wf = (state.orgMap?.workflows || []).find((w) => w.id === workflowId);
    if (wf) wf.mapping = res.mapping || {};
    await loadOrg(); // refresh the portfolio so gated panels update live
  } catch (e) {
    state.orgMapErr = /\b403\b/.test(e.message) ? "Only organisation admins can change attribute mappings." : e.message;
  } finally {
    state.orgMapBusy = false; render();
  }
}

export function orgMapBody(m) {
  return (m.capabilities || []).map((cap) => {
    const rows = (m.workflows || []).map((w) => {
      if (!w.hasModel) {
        return `<div class="flex items-center gap-3 py-2 border-t border-stone-100"><div class="flex-1 text-sm text-stone-500 truncate">${escapeHtml(w.name)}</div><div class="text-xs text-stone-400">no model yet</div></div>`;
      }
      const cur = w.mapping?.[cap.key] || "";
      const opts = [`<option value="">— not mapped —</option>`].concat((w.fields || []).map((f) => {
        const sel = f.name === cur ? "selected" : "";
        const sug = (f.name === w.suggested && !cur) ? " (suggested)" : "";
        return `<option value="${escapeHtml(f.name)}" ${sel}>${f.dateish ? "📅 " : ""}${escapeHtml(f.name)}${f.dataType ? ` · ${escapeHtml(f.dataType)}` : ""}${sug}</option>`;
      })).join("");
      const hint = !cur && w.suggested ? `<div class="text-[11px] text-stone-400 mt-0.5">suggested: ${escapeHtml(w.suggested)}</div>` : "";
      return `
        <div class="flex items-center gap-3 py-2 border-t border-stone-100">
          <div class="flex-1 min-w-0"><div class="text-sm font-medium text-stone-800 truncate">${escapeHtml(w.name)}</div>${hint}</div>
          <select data-map-select data-map-wf="${w.id}" data-map-cap="${cap.key}" ${state.orgMapBusy ? "disabled" : ""} class="rounded-md border border-stone-300 px-2 py-1.5 text-sm max-w-[260px]">${opts}</select>
        </div>`;
    }).join("");
    return `
      <div class="mb-5">
        <div class="text-sm font-semibold text-stone-800">${escapeHtml(cap.label)}</div>
        <div class="text-xs text-stone-500 mt-0.5 mb-1">${escapeHtml(cap.description)} <span class="text-stone-400">Unlocks: ${escapeHtml(cap.unlocks)}</span></div>
        ${rows || `<div class="text-sm text-stone-400 py-2">No workflows.</div>`}
      </div>`;
  }).join("");
}

export function orgMapDialog() {
  if (!state.orgMapOpen) return "";
  const m = state.orgMap;
  const inner = !m ? `<div class="py-8 text-center text-sm text-stone-500">Loading…</div>`
    : m.error ? `<div class="py-8 text-center text-sm text-rose-600">${escapeHtml(m.error)}</div>`
    : orgMapBody(m);
  const err = state.orgMapErr ? `<div class="px-5 py-2 text-sm text-rose-600 bg-rose-50 border-t border-rose-100">${escapeHtml(state.orgMapErr)}</div>` : "";
  return `
    <div data-org-map-close class="fixed inset-0 z-50 bg-black/40"></div>
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col pointer-events-auto">
        <div class="px-5 py-4 border-b border-stone-200 flex items-start justify-between gap-4">
          <div>
            <div class="text-lg font-semibold">Map dashboard attributes</div>
            <div class="text-sm text-stone-500 mt-0.5">Point each workflow's own fields at the attributes a dashboard panel needs. Panels light up as workflows are mapped; partially-mapped panels flag the rest. Admin only.</div>
          </div>
          <button data-org-map-close class="text-stone-400 hover:text-stone-700 text-xl leading-none">✕</button>
        </div>
        <div class="overflow-auto p-5 flex-1">${inner}</div>
        ${err}
        <div class="px-5 py-3 border-t border-stone-200 flex justify-end">
          <button data-org-map-close class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Done</button>
        </div>
      </div>
    </div>`;
}

export function bindOrgMap() {
  if (!state.orgMapOpen) return;
  document.querySelectorAll("[data-org-map-close]").forEach((el) => el.addEventListener("click", () => { state.orgMapOpen = false; state.orgMapErr = null; render(); }));
  document.querySelectorAll("[data-map-select]").forEach((el) => el.addEventListener("change", () => {
    orgSaveMapping(el.getAttribute("data-map-wf"), el.getAttribute("data-map-cap"), el.value);
  }));
}

