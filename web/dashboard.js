// Per-workflow dashboard (#/#flow/#rows/#list) — case list + merged/per-case
// flow overview and the model-generic row rendering. Extracted from app.js.
import { state } from "./state.js";
import { escapeHtml, prettyEntity } from "./format.js";
import { provChip } from "./chips.js";
import { api, navigate, render } from "./app.js";
import { pill, viewSwitcher } from "./detail.js";
import { loadRegistryStatus } from "./model.js";
import {
  applyQuery, bindOvToolbar, caseRecords, colMeta, fmtStamp, listColTokens,
  ovActive, ovPager, ovToolbar, sortableTh,
} from "./ovquery.js";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// The full case/flow-row payloads are large (megabytes at thousands of cases),
// so the 5s live poll must NOT re-download them every tick. Each full load
// records a cheap change-stamp from the flow aggregate (total cases + total
// firings); the poll re-fetches that stamp only (a few bytes) and re-downloads
// the heavy payloads solely when it moves. `null` forces the next poll to reload.
let _ovStamp = null;
function stampOf(flow) { return flow ? `${flow.totalCases}:${flow.totalFirings}` : ""; }

// Every Overview tab loads the SAME full dataset (?limit=0 lifts the server
// caps): the case rows, the per-case flow rows, AND the flow aggregate (cheap,
// also seeds the poll stamp + feeds the merged counters). The shared query
// engine (ovquery.js) filters/sorts/pages client-side, so a search on one tab
// carries to the others and only the current page is ever rendered.
export async function loadDashboard() {
  const [cases, events, rows, flow] = await Promise.all([
    api("/sim/cases?limit=0"), api("/sim/events"), api("/sim/flow-by-case?limit=0"), api("/sim/flow-aggregate"),
    loadRegistryStatus(), loadMeta(),
  ]);
  state.cases = cases;
  state.events = events;
  state.flowRows = rows;
  state.flow = flow;
  _ovStamp = stampOf(flow);
  render();
}

// Merged "all cases" flow (#flow): the model's events plus per-event firing
// counts across every case (no single case loaded — state.flow.counts is the
// aggregate). Same model + meta the single-case flow uses, so the diagram is
// laid out identically; only the badges' meaning changes (all-cases totals).
// The per-case rows + case rows ride along so an active search/filter can
// recompute the counters over just the matching cases (ovquery flowSlice).
export async function loadFlow() {
  const [flow, events, rows, cases] = await Promise.all([
    api("/sim/flow-aggregate"), api("/sim/events"), api("/sim/flow-by-case?limit=0"), api("/sim/cases?limit=0"),
    loadRegistryStatus(), loadMeta(),
  ]);
  state.flow = flow;
  state.events = events;
  state.flowRows = rows;
  state.cases = cases;
  _ovStamp = stampOf(flow);
  render();
}

// Per-case flow (#rows): the same model events plus each case's own ref→count
// map, so the merged flow can be split into one row per case. Shares the events +
// meta the merged flow uses, so columns line up identically. The old server-side
// 50-row cap is gone — pagination (ovquery) bounds what actually renders.
export async function loadFlowRows() {
  const [rows, events, cases, flow] = await Promise.all([
    api("/sim/flow-by-case?limit=0"), api("/sim/events"), api("/sim/cases?limit=0"), api("/sim/flow-aggregate"),
    loadRegistryStatus(), loadMeta(),
  ]);
  state.flowRows = rows;
  state.events = events;
  state.cases = cases;
  state.flow = flow;
  _ovStamp = stampOf(flow);
  render();
}

// The 5s live-poll body for every Overview tab. Fetches ONLY the tiny flow
// aggregate; if nothing changed it just re-renders (to age relative timestamps
// and keep the merged counters live) without touching the heavy endpoints, and
// only re-runs the full loader when the stamp actually moves.
export async function pollOverview(view) {
  if (state.busy) return;
  let flow;
  try { flow = await api("/sim/flow-aggregate"); } catch { return; }
  state.flow = flow; // keep #flow counters live even on a no-change tick
  const stamp = stampOf(flow);
  if (stamp === _ovStamp) { render(); return; }
  _ovStamp = stamp;
  if (view === "flow") await loadFlow();
  else if (view === "rows") await loadFlowRows();
  else await loadDashboard();
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
      if (state.view === "flow" && !state.busy) pollOverview("flow").catch(() => {});
    }, 5000);
  } else {
    state.view = "dashboard";
    await loadDashboard();
    state.dashboardTimer = setInterval(() => {
      if (state.view === "dashboard" && !state.busy) pollOverview("dashboard").catch(() => {});
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

// The List's column plan: the chosen tokens with the mandatory Progress column
// pinned where it has always lived (before "last activity" when that column is
// on, else at the end). "$progress" is the pin — never choosable, always there.
export function listColumnPlan(records) {
  const toks = listColTokens(records);
  const before = toks.filter((t) => t !== "$lastEvent");
  return [...before, "$progress", ...(toks.includes("$lastEvent") ? ["$lastEvent"] : [])];
}

function listCell(d, tok) {
  if (tok === "$progress") {
    const pct = Math.round((d.progress / d.total) * 100) || 0;
    return `
      <td class="px-4 py-3 w-56">
        <div class="flex items-center gap-2" title="${pct}% — ${d.progress} of ${d.total} steps">
          <div class="flex-1 h-1.5 bg-stone-200 rounded overflow-hidden"><div class="h-1.5 bg-amber-400 transition-all" style="width:${pct}%"></div></div>
          <div class="text-xs text-stone-500 tabular-nums w-12 text-right">${d.progress}/${d.total}</div>
        </div>
      </td>`;
  }
  if (tok === "$status") return `<td class="px-4 py-3">${d.status ? pill(d.status, d.status) : "—"}</td>`;
  if (tok === "$createdAt" || tok === "$updatedAt") {
    const iso = tok === "$createdAt" ? d.createdAt : d.updatedAt;
    return `<td class="px-4 py-3 text-xs text-stone-500 whitespace-nowrap" ${iso ? `title="${escapeHtml(new Date(iso).toLocaleString())}"` : ""}>${escapeHtml(fmtStamp(iso))}</td>`;
  }
  if (tok === "$lastEvent") {
    return `<td class="px-4 py-3 text-xs">${d.lastEvent ? `<div class="text-stone-700 flex items-center gap-1.5">${escapeHtml(d.lastEvent.eventName)} ${provChip(d.lastEvent.provenance)}</div>` : `<span class="text-stone-400">no events yet</span>`}</td>`;
  }
  return `<td class="px-4 py-3 text-sm text-stone-700">${attrCellHtml(d[tok])}</td>`;
}

export function dashboardRow(d, plan) {
  const cells = plan.map((tok) => listCell(d, tok)).join("");
  // The case id is source-controlled (an ingested row may carry a hostile id),
  // so escape it at every sink — encode for the navigation hash, HTML-escape for
  // the attribute and body (mirrors the By-case rows in detail.js).
  return `
    <tr class="cursor-pointer hover:bg-amber-50 transition-colors" data-go="#case/${encodeURIComponent(d.id)}">
      <td class="px-4 py-3"><span class="inline-block w-2 h-2 rounded-full bg-stone-300"></span></td>
      <td class="px-4 py-3 mono text-stone-500 text-xs" title="${escapeHtml(d.id)}">${escapeHtml(d.id.slice(0, 16))}…</td>
      ${cells}
      <td class="px-4 py-3 text-right"><button class="text-stone-400 hover:text-rose-600 text-sm" data-delete="${escapeHtml(d.id)}" title="Reset this run">✕</button></td>
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
// Deep, SEARCH-ONLY flattening of a structured value: every nested leaf (string/
// number/boolean) joined into one blob so free-text search and "contains" match
// values the collapsed display (attrText) hides — e.g. the "city" inside an
// address object that only shows its "street". Never used for display or sort.
export function attrSearchText(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  let v = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[") return v;      // plain string — as-is
    try { v = JSON.parse(t); } catch { return v; }
  }
  if (typeof v !== "object") return String(v);
  const out = [];
  const walk = (x) => {
    if (x === null || x === undefined) return;
    if (typeof x === "object") { for (const k of Object.keys(x)) walk(x[k]); }
    else out.push(String(x));
  };
  walk(v);
  return out.join(" ");
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
  // Unified records (case rows joined with flow rows) → the shared query
  // engine: filter → sort → the one page that actually renders.
  const records = caseRecords().filter((r) => r.row);
  const res = applyQuery(records, "list");
  const plan = listColumnPlan(records);
  const rows = res.rows.map((rec) => dashboardRow(rec.row, plan)).join("");
  const empty = records.length === 0;
  const noMatch = !empty && res.total === 0;
  const plural = prettyEntity(m.rootAggregatePlural), singular = prettyEntity(m.rootAggregate);
  const headerCells = plan.map((tok) => {
    const c = colMeta(tok);
    return sortableTh(c.sort, c.label);
  }).join("");
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
    ${empty ? "" : ovToolbar("list", records, res)}
    <main class="flex-1 overflow-auto p-6">
      ${empty ? `
        <div class="max-w-md mx-auto mt-16 text-center">
          <div class="text-stone-400 text-5xl mb-3">∅</div>
          <div class="text-lg font-medium text-stone-700">No ${escapeHtml(plural.toLowerCase())} yet</div>
          <div class="text-sm text-stone-500 mt-1">Click <b>+ New ${escapeHtml(singular.toLowerCase())}</b> to start a fresh instance through the workflow.</div>
        </div>
      ` : noMatch ? `
        <div class="max-w-md mx-auto mt-16 text-center">
          <div class="text-stone-400 text-5xl mb-3">⌕</div>
          <div class="text-lg font-medium text-stone-700">No ${escapeHtml(plural.toLowerCase())} match</div>
          <div class="text-sm text-stone-500 mt-1">Nothing matches the current search and filters.</div>
          <button id="ov-nomatch-clear" class="mt-4 px-4 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Clear search &amp; filters</button>
        </div>
      ` : `
        <div class="rounded-lg border border-stone-200 bg-white overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-stone-50 border-b border-stone-200">
              <tr class="text-left text-[11px] uppercase tracking-wide text-stone-500">
                <th class="px-4 py-2 font-medium w-6"></th>
                ${sortableTh("id", "id")}
                ${headerCells}
                <th class="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-100">${rows}</tbody>
          </table>
          <div class="px-4 py-2 border-t border-stone-200 bg-stone-50 flex items-center justify-between gap-4">
            <span class="text-xs text-stone-500">${ovActive() ? `Filtered — <span class="tabular-nums">${res.total.toLocaleString()}</span> of <span class="tabular-nums">${records.length.toLocaleString()}</span> ${escapeHtml(plural.toLowerCase())}` : ""}</span>
            ${ovPager("list", res)}
          </div>
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
  bindOvToolbar("list");
  document.getElementById("ov-nomatch-clear")?.addEventListener("click", () => {
    document.getElementById("ov-clear")?.click();
  });
}

