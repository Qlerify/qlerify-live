// Per-workflow dashboard (#/#flow/#rows/#list) — case list + merged/per-case
// flow overview and the model-generic row rendering. Extracted from app.js.
import { state } from "./state.js";
import { escapeHtml, prettyEntity } from "./format.js";
import { provChip } from "./chips.js";
import { api, navigate, render } from "./app.js";
import { pill, viewSwitcher } from "./detail.js";
import { loadRegistryStatus } from "./model.js";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function loadDashboard() {
  const [cases, events] = await Promise.all([api("/sim/cases"), api("/sim/events"), loadRegistryStatus(), loadMeta()]);
  state.cases = cases;
  state.events = events;
  render();
}

// Merged "all cases" flow (#flow): the model's events plus per-event firing
// counts across every case (no single case loaded — state.flow.counts is the
// aggregate). Same model + meta the single-case flow uses, so the diagram is
// laid out identically; only the badges' meaning changes (all-cases totals).
export async function loadFlow() {
  const [flow, events] = await Promise.all([api("/sim/flow-aggregate"), api("/sim/events"), loadRegistryStatus(), loadMeta()]);
  state.flow = flow;
  state.events = events;
  render();
}

// Per-case flow (#rows): the same model events plus each case's own ref→count
// map, so the merged flow can be split into one row per case. Shares the events +
// meta the merged flow uses, so columns line up identically.
export async function loadFlowRows() {
  // Also pull the case rows (same data the List uses) so each row's gutter can
  // show that case's mandatory attribute values, joined by id.
  const q = state.flowRowsShowAll ? "?limit=0" : "";
  const [rows, events, cases] = await Promise.all([api("/sim/flow-by-case" + q), api("/sim/events"), api("/sim/cases"), loadRegistryStatus(), loadMeta()]);
  state.flowRows = rows;
  state.events = events;
  state.cases = cases;
  render();
}

// The Overview "home" (#) is a smart default: the merged Workflow flow once this
// workflow has cases, otherwise the case List — whose empty-state onboards the
// first case. We peek at the flow aggregate's case count to choose, then hand off
// to loadFlow/loadDashboard (each owns its own fetch + 5s live poll) and resolve
// state.view away from the transient "overview" sentinel.
export async function loadOverview() {
  let totalCases = 0;
  try {
    const flow = await api("/sim/flow-aggregate");
    state.flow = flow;
    totalCases = flow.totalCases ?? 0;
  } catch { /* fall through to the List, which carries its own empty-state */ }
  if (totalCases > 0) {
    state.view = "flow";
    await loadFlow();
    state.dashboardTimer = setInterval(() => {
      if (state.view === "flow" && !state.busy) loadFlow().catch(() => {});
    }, 5000);
  } else {
    state.view = "dashboard";
    await loadDashboard();
    state.dashboardTimer = setInterval(() => {
      if (state.view === "dashboard" && !state.busy) loadDashboard().catch(() => {});
    }, 5000);
  }
}

// Model-derived UI labels — fetched once and reused; failures keep the defaults.
export async function loadMeta() {
  try {
    const meta = await api("/sim/meta");
    state.meta = meta;
    document.title = `${meta.title} — Live`;
  } catch { /* keep defaults */ }
}

export async function createCase() {
  if (state.busy) return;
  state.busy = true; render();
  try {
    const d = await api("/sim/cases", { method: "POST", body: "{}" });
    await loadDashboard();
    // Auto-navigate into the new case's detail view.
    navigate(`#case/${d.id}`);
  } catch (e) {
    alert(e.message);
  } finally {
    state.busy = false; render();
  }
}

export async function deleteCase(caseId, ev) {
  ev.stopPropagation();
  if (!confirm("Remove this item and all its data?")) return;
  state.busy = true; render();
  try {
    await api("/sim/delete", { method: "POST", body: JSON.stringify({ caseId }) });
    await loadDashboard();
  } catch (e) {
    alert("Delete failed: " + e.message);
  } finally {
    state.busy = false; render();
  }
}

export function dashboardRow(d, cols) {
  const pct = Math.round((d.progress / d.total) * 100) || 0;
  // Columns derived from the root-aggregate row's own fields (model-generic).
  const cells = (cols || []).map((c) => `<td class="px-4 py-3 text-sm text-stone-700">${attrCellHtml(d[c])}</td>`).join("");
  return `
    <tr class="cursor-pointer hover:bg-amber-50 transition-colors" data-go="#case/${d.id}">
      <td class="px-4 py-3"><span class="inline-block w-2 h-2 rounded-full bg-stone-300"></span></td>
      <td class="px-4 py-3 mono text-stone-500 text-xs">${d.id.slice(0, 16)}…</td>
      ${cells}
      <td class="px-4 py-3">${d.status ? pill(d.status, d.status) : "—"}</td>
      <td class="px-4 py-3 w-64">
        <div class="flex items-center gap-2">
          <div class="flex-1 h-1.5 bg-stone-200 rounded overflow-hidden"><div class="h-1.5 bg-amber-400 transition-all" style="width:${pct}%"></div></div>
          <div class="text-xs text-stone-500 tabular-nums w-12 text-right">${d.progress}/${d.total}</div>
        </div>
      </td>
      <td class="px-4 py-3 text-xs">${d.lastEvent ? `<div class="text-stone-700 flex items-center gap-1.5">${escapeHtml(d.lastEvent.eventName)} ${provChip(d.lastEvent.provenance)}</div>` : `<span class="text-stone-400">no events yet</span>`}</td>
      <td class="px-4 py-3 text-right"><button class="text-stone-400 hover:text-rose-600 text-sm" data-delete="${d.id}" title="Reset this run">✕</button></td>
    </tr>`;
}

// List columns derived from the root-aggregate rows of the loaded model.
export function genericColumns(rows) {
  const reserved = new Set(["id", "version", "createdAt", "updatedAt", "status", "progress", "total", "lastEvent", "dwellSeconds"]);
  const first = rows[0] || {};
  return Object.keys(first).filter((k) => !reserved.has(k)).slice(0, 4);
}

// Render a case attribute value for the narrow UI (the by-case gutter): scalars
// as-is, but a structured value — an object/array, or a JSON string holding one —
// collapsed to a readable scalar instead of dumping raw JSON. Some models store a
// mandatory attribute as a value object (or a JSON-encoded string), which would
// otherwise show as `{"...":...}` / `[object Object]` in the gutter.
export function attrText(raw) {
  if (raw === undefined || raw === null || raw === "") return "—";
  let v = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[") return v;     // plain string — show as-is
    try { v = JSON.parse(t); } catch { return v; }  // looked like JSON but wasn't
  }
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(attrScalar).filter((s) => s !== "");
    return parts.length ? parts.join(", ") : "—";
  }
  return attrScalar(v) || "—";
}
// The most human-readable scalar inside an object: a name-ish field if present,
// else the first primitive value; "" when there is nothing scalar to show.
export function attrScalar(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  for (const k of ["name", "title", "label", "displayName", "value", "id"]) {
    if (typeof v[k] === "string" || typeof v[k] === "number") return String(v[k]);
  }
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return String(x);
  }
  return "";
}

// Render a List-view cell: scalars as-is, but a structured value (object/array,
// or a JSON string holding one) as one line per contained value instead of raw
// JSON — smaller type, capped at 4 lines with a "+N more" hint so one rich field
// can't blow up the row height. Nested structures collapse to a readable scalar.
export function attrCellHtml(raw) {
  if (raw === undefined || raw === null || raw === "") return "—";
  let v = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[") return escapeHtml(v);
    try { v = JSON.parse(t); } catch { return escapeHtml(v); }
  }
  if (typeof v !== "object") return escapeHtml(String(v));
  const lines = (Array.isArray(v) ? v : Object.values(v))
    .map((x) => attrText(x))
    .filter((s) => s !== "—");
  if (!lines.length) return "—";
  if (lines.length === 1) return escapeHtml(lines[0]);
  const shown = lines.slice(0, 4).map((s) => `<div class="text-xs leading-snug">${escapeHtml(s)}</div>`).join("");
  const more = lines.length > 4 ? `<div class="text-[10px] text-stone-400">+${lines.length - 4} more</div>` : "";
  return shown + more;
}

export function dashboardView() {
  const m = state.meta;
  const cols = genericColumns(state.cases);
  const rows = state.cases.map((d) => dashboardRow(d, cols)).join("");
  const empty = state.cases.length === 0;
  const plural = prettyEntity(m.rootAggregatePlural), singular = prettyEntity(m.rootAggregate);
  const headerCells = cols.map((c) => `<th class="px-4 py-2 font-medium">${escapeHtml(c)}</th>`).join("");
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(m.title)} — ${escapeHtml(plural)}</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">All ${escapeHtml(plural.toLowerCase())} in flight</div>
        </div>
        <button id="btn-new-case" ${state.busy ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">+ New ${escapeHtml(singular.toLowerCase())}</button>
        ${viewSwitcher("list")}
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    <main class="flex-1 overflow-auto p-6">
      ${empty ? `
        <div class="max-w-md mx-auto mt-16 text-center">
          <div class="text-stone-400 text-5xl mb-3">∅</div>
          <div class="text-lg font-medium text-stone-700">No ${escapeHtml(plural.toLowerCase())} yet</div>
          <div class="text-sm text-stone-500 mt-1">Click <b>+ New ${escapeHtml(singular.toLowerCase())}</b> to start a fresh instance through the workflow.</div>
        </div>
      ` : `
        <div class="rounded-lg border border-stone-200 bg-white overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-stone-50 border-b border-stone-200">
              <tr class="text-left text-[11px] uppercase tracking-wide text-stone-500">
                <th class="px-4 py-2 font-medium w-6"></th>
                <th class="px-4 py-2 font-medium">id</th>
                ${headerCells}
                <th class="px-4 py-2 font-medium">status</th>
                <th class="px-4 py-2 font-medium">progress</th>
                <th class="px-4 py-2 font-medium">last activity</th>
                <th class="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-100">${rows}</tbody>
          </table>
        </div>
      `}
    </main>
    <footer class="px-6 py-3 text-xs text-stone-500 border-t border-stone-200 bg-stone-50">
      <span>Generated from the live Qlerify model.</span>
      <span class="mx-2">·</span>
      <span>${state.events.length} events · ${state.meta.boundedContextCount} systems · ${state.meta.aggregateCount} aggregates</span>
    </footer>
  `;
}

export function bindDashboard() {
  document.getElementById("btn-new-case")?.addEventListener("click", createCase);
  document.querySelectorAll("[data-go]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.go));
  });
  document.querySelectorAll("[data-delete]").forEach((el) => {
    el.addEventListener("click", (ev) => deleteCase(el.dataset.delete, ev));
  });
}

