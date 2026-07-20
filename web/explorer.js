// Systems explorer (#bcs) — three-pane data console (systems → tables → items)
// + the connector-builder entry points. Extracted from app.js.
import { state } from "./state.js";
import { escapeHtml } from "./format.js";
import { api, render, showOverlay, hideOverlay } from "./app.js";
import { formatVersionDate } from "./model.js";
import { activateConnectorChat, loadChatInfo } from "./chat.js";

// ===========================================================================
// Systems explorer (#bcs) — a three-pane data console:
//   Systems (bounded contexts) | Tables (entities) | Items (gen_ rows)
// + a Filters panel and a Configure Adapter sidebar (chat builder: later).
// Backed by /api/bc, /api/bc/:bc, /api/bc/:bc/raw — no new backend.
// ===========================================================================

export function expState () {
  if (!state.exp) {
    state.exp = {
      systems: [],
      system: null,
      entities: [],
      valueObjects: [],
      entity: null,
      items: [],
      adapters: [],
      health: null,
      filters: [],
      page: 0,
      panelMode: 'history',
      sysCollapsed: false,
      tablesCollapsed: false,
      busy: false,
      tableMissing: false,
      rowEvents: {},
      rowEventsBusy: false
    }
  }
  return state.exp;
}

export async function loadExplorer() {
  const e = expState();
  try { e.systems = await api("/api/bc"); } catch (_err) { e.systems = []; }
  loadHealth(); // per-table connection status for the Tables pane; renders when it lands
  const cur = e.system && e.systems.find((s) => s.name === e.system);
  const want = e.pendingEntity; e.pendingEntity = null; // one-shot deep-link target table
  if (e.systems[0]) { await selectExpSystem(cur ? e.system : e.systems[0].name, want); return; }
  render();
}

// Per-table connection status (4-state) for EVERY system — the dot on each row of
// the Tables pane. Derived server-side from adapters + gen_ row counts.
export async function loadHealth() {
  const e = expState();
  try { e.health = await api("/api/bc/health"); } catch (_err) { e.health = { gaps: 0, systems: [] }; }
  render();
}

export async function selectExpSystem(name, targetEntity) {
  const e = expState();
  e.system = name; e.entity = null; e.items = []; e.filters = []; e.page = 0;
  try {
    const d = await api(`/api/bc/${encodeURIComponent(name)}`);
    e.entities = d.entities || [];
    e.valueObjects = d.valueObjects || [];
    e.adapters = d.adapters || [];
    const def = targetEntity || d.defaultEntity || (e.entities[0] && e.entities[0].name) || (e.valueObjects[0] && e.valueObjects[0].name);
    if (def) { await selectExpEntity(def); return; }
  } catch (_err) { e.entities = []; e.valueObjects = []; e.adapters = []; }
  activateConnectorChat(e.system, e.entity); // no table → this system's empty thread
  render();
}

export async function selectExpEntity(name) {
  const e = expState();
  e.entity = name; e.page = 0; e.filters = []; e.busy = true;
  activateConnectorChat(e.system, name); // swap in this table's own connector thread
  render();
  showOverlay("Loading data…"); // 150ms-delayed → quick table loads won't flash
  try {
    try {
      const d = await api(`/api/bc/${encodeURIComponent(e.system)}/raw?entity=${encodeURIComponent(name)}&limit=300`);
      e.items = d.rows || [];
      e.tableMissing = !!d.tableMissing;
    } catch (_err) { e.items = []; e.tableMissing = true; }
    e.rowEvents = {}; // events belong to the previous table — drop them
    e.rowEvents = await fetchRowEvents(e);
  } finally {
    e.busy = false; hideOverlay();
  }
}

// Fetch the per-row event trail for the selected table: { rowId: [event, …] }.
// Returns the map (no render) so callers control when the UI updates.
export async function fetchRowEvents(e) {
  if (!e.system || !e.entity) return {};
  try {
    const d = await api(`/api/bc/${encodeURIComponent(e.system)}/row-events?entity=${encodeURIComponent(e.entity)}&limit=2000`);
    return d.byRow || {};
  } catch (_err) { return {}; }
}

export function expAdaptersForEntity(e) {
  return (e.adapters || []).filter((a) => a.targetEntity === e.entity);
}

export async function expFetchRows() {
  const e = expState();
  if (e.busy || !e.entity) return;
  const adapters = expAdaptersForEntity(e);
  if (!adapters.length) {
    alert("No connector configured for this table. Use the “Configure connector” button to build one first.");
    return;
  }
  const adapter = adapters[0];
  if (!confirm(`Fetch rows from the data source via connector "${adapter.id}"?\n\nNew rows are inserted; rows with an id already in the table are skipped.`)) return;
  e.busy = true; render();
  showOverlay("Refreshing data…");
  try {
    const r = await api(`/api/adapters/${encodeURIComponent(adapter.id)}/pull`, { method: "POST", body: JSON.stringify({ limit: 1000 }) });
    await refreshExplorerAfterChat(); // re-pulls rows, adapters AND (if shown) the per-row events so the auto-derived events land in the ⚡ Events column
    hideOverlay(); // drop the scrim before the blocking result alert
    const ev = r.derived && r.derived.events ? `\nEvents derived: ${r.derived.events} (${r.derived.instances} instance(s))` : "";
    alert(`Fetched from source.\n\nInserted: ${r.inserted}\nSkipped (already present): ${r.skipped}${ev}`);
  } catch (err) {
    hideOverlay();
    alert("Fetch failed: " + err.message);
  } finally {
    e.busy = false; render();
  }
}

export async function expClearRows() {
  const e = expState();
  if (e.busy || !e.entity || !e.system) return;
  if (!confirm(`Delete ALL rows in table "${e.entity}"?\n\nThis clears the ingested data for this table AND the simulated events derived from it. Connectors are kept.`)) return;
  e.busy = true; render();
  showOverlay("Deleting rows…");
  try {
    const r = await api(`/api/bc/${encodeURIComponent(e.system)}/clear`, { method: "POST", body: JSON.stringify({ entity: e.entity }) });
    await refreshExplorerAfterChat(); // re-pulls rows AND adapters so the new "cleared" note shows in the history
    hideOverlay(); // drop the scrim before the blocking result alert
    const evt = r.eventsDeleted ? ` and ${r.eventsDeleted} derived event(s)` : "";
    alert(r.deleted ? `Deleted ${r.deleted} row(s)${evt} from ${e.entity}.` : `No rows to delete in ${e.entity}.`);
  } catch (err) {
    hideOverlay();
    alert("Delete failed: " + err.message);
  } finally {
    e.busy = false; render();
  }
}

// Global "Reset & reimport base data": empties every base-data table AND the whole
// event log, then re-pulls every configured connector to restore the data from
// source. The Systems-wide counterpart to the per-table Fetch/Delete buttons —
// connectors and the model are kept.
export async function expReimportAll() {
  const e = expState();
  if (e.busy) return;
  if (!confirm("Empty ALL base-data tables and the entire event log, then reimport the base data from every configured connector?\n\nThis clears every ingested row and derived event across all systems, then re-pulls each connector from its source. Connectors and the model are kept.")) return;
  e.busy = true; render();
  showOverlay("Resetting & reimporting…");
  try {
    const r = await api("/api/data/reimport-all", { method: "POST", body: JSON.stringify({ limit: 1000 }) });
    await refreshExplorerAfterChat();
    try { e.health = await api("/api/bc/health"); } catch (_e) { /* keep prior */ } // refresh status dots even if no table is selected
    hideOverlay(); // drop the scrim before the blocking result alert
    const ev = r.derived ? `\nEvents derived: ${r.derived.events} (${r.derived.instances} instance(s))` : "";
    const failed = r.failures && r.failures.length ? `\nConnectors that failed: ${r.failures.length} (${r.failures.map((f) => f.id).join(", ")})` : "";
    alert(`Reset & reimport complete.\n\nConnectors pulled: ${r.connectors}\nRows inserted: ${r.inserted}${ev}${failed}`);
  } catch (err) {
    hideOverlay();
    alert("Reset & reimport failed: " + err.message);
  } finally {
    e.busy = false; render();
  }
}

// Is the selected table an entity or a value object? (drives the chat context +
// the sidebar label).
export function expKindOf(e, name) {
  if (!name) return null;
  if ((e.entities || []).some((t) => t.name === name)) return "entity";
  if ((e.valueObjects || []).some((t) => t.name === name)) return "valueObject";
  return null;
}

// Open the assistant docked on the right as the connector builder, scoped (via
// sendChat's context injection) to the selected system + table. Closes the
// Configure-Adapter sidebar first so the two right panels don't stack.
export function openConnectorChat() {
  const e = expState();
  e.panelMode = "chat";
  activateConnectorChat(e.system, e.entity); // ensure the selected table's thread is live
  state.chatOpen = true;
  if (!state.chatInfo) loadChatInfo().then(render);
  render();
  setTimeout(() => document.getElementById("chat-input")?.focus(), 30);
}

// After a connector-builder turn, re-pull the system's adapters + the selected
// table's rows so a create/build/ingest shows immediately in the explorer.
export async function refreshExplorerAfterChat() {
  const e = expState();
  if (!e.system) return;
  try {
    const d = await api(`/api/bc/${encodeURIComponent(e.system)}`);
    e.adapters = d.adapters || [];
    e.entities = d.entities || e.entities;
    e.valueObjects = d.valueObjects || e.valueObjects;
  } catch (_e) { /* keep prior */ }
  if (e.entity) {
    try {
      const d = await api(`/api/bc/${encodeURIComponent(e.system)}/raw?entity=${encodeURIComponent(e.entity)}&limit=300`);
      e.items = d.rows || [];
      e.tableMissing = !!d.tableMissing;
    } catch (_e) { /* keep prior */ }
    // Ingest/clear changes the derived events too → refresh the per-row trail.
    e.rowEvents = await fetchRowEvents(e);
  }
  // A create/build/ingest changes connection status → refresh the Tables-pane
  // status dots too so they update without a manual reload (caller renders).
  try { e.health = await api("/api/bc/health"); } catch (_e) { /* keep prior */ }
}

export function applyExpFilters(items, filters) {
  const active = (filters || []).filter((f) => f.attr && f.value !== "");
  if (!active.length) return items;
  return items.filter((row) => active.every((f) => {
    let v = row[f.attr]; let t = f.value;
    if (f.type === "Number") { v = Number(v); t = Number(t); } else { v = String(v == null ? "" : v).toLowerCase(); t = String(t).toLowerCase(); }
    switch (f.cond) {
      case "Equal to": return v == t;
      case "Not equal to": return v != t;
      case "Contains": return String(v).includes(String(t));
      case "Begins with": return String(v).startsWith(String(t));
      case "Greater than": return v > t;
      case "Less than": return v < t;
      default: return true;
    }
  }));
}

export function explorerView() {
  const e = expState();
  return `
    <div class="flex-1 flex min-h-0 overflow-hidden bg-stone-50">
      ${expSystemsCol(e)}
      ${expTablesCol(e)}
      ${expMain(e)}
    </div>`;
}

// Dot + label per 4-state connection status, shown on every Tables-pane row.
export const STATUS_DOT = {
  live: "bg-emerald-500",
  simulated: "bg-sky-500",
  wired_empty: "bg-white border-2 border-amber-400",
  no_adapter: "bg-white border-2 border-stone-300",
};
export const STATUS_LABEL = {
  live: "Live data — connected to a live source",
  simulated: "Simulated / recorded data",
  wired_empty: "Connector configured, but no data pulled yet",
  no_adapter: "No connector — not connected to a source",
};

// One marker per table row: SHAPE encodes type (square = entity, diamond = value
// object), COLOR encodes the 4-state connection status (same scheme as before).
// The full type + state is spelled out in the hover tooltip.
export function tableGlyph(kind, status) {
  const vo = kind === "valueObject";
  const typeTip = vo
    ? "Value object — defined only by its attributes, no identity of its own"
    : "Entity — a thing with a unique identity and its own lifecycle";
  const shape = `<span class="w-2.5 h-2.5 rounded-sm ${vo ? "rotate-45" : ""} ${STATUS_DOT[status] || STATUS_DOT.no_adapter}"></span>`;
  // p-1 / -m-1 enlarges the hover target without changing the 10px visual; the
  // custom tooltip (initTooltips) reads data-tip-* and opens instantly.
  return `<span data-tip-type="${escapeHtml(typeTip)}" data-tip-status="${escapeHtml(STATUS_LABEL[status] || status)}" class="shrink-0 inline-flex items-center justify-center p-1 -m-1 cursor-help">${shape}</span>`;
}

// One render row per table, in system order, flagged with the FIRST table of each
// system so the Systems column can print the system name aligned to it. A system
// with no tables still yields one (table-less) row so both columns stay 1:1.
export function expRowEntries(e) {
  const systems = (e.health && e.health.systems) || [];
  const entries = [];
  let firstSystem = true; // a divider goes before every system EXCEPT the first
  for (const s of systems) {
    const sep = !firstSystem;
    if (!s.tables.length) { entries.push({ system: s, table: null, first: true, sep }); firstSystem = false; continue; }
    s.tables.forEach((t, i) => entries.push({ system: s, table: t, first: i === 0, sep: i === 0 && sep }));
    firstSystem = false;
  }
  return entries;
}

export function expSystemsCol(e) {
  if (e.sysCollapsed) {
    return `<div class="w-9 shrink-0 border-r border-stone-200 bg-white flex flex-col items-center pt-3"><button id="exp-sys-expand" class="text-stone-400 hover:text-stone-700" title="Show systems">›</button></div>`;
  }
  // One row per table (aligned 1:1 with the Tables column via synced scroll), but the
  // system name is printed only on its first table's row — so each system lines up
  // with where its tables begin, and isn't repeated down the column.
  const entries = expRowEntries(e);
  const rows = entries.map((en) => {
    const active = en.system.name === e.system;
    const label = en.first
      ? `<button data-exp-sys="${escapeHtml(en.system.name)}" class="text-sm text-left truncate ${active ? "text-sky-700 font-semibold" : "text-stone-700 hover:text-stone-900"}">${escapeHtml(en.system.name)}</button>`
      : "";
    return `<div class="h-9 flex items-center px-4 ${en.sep ? "mt-2 border-t border-stone-200" : ""} ${en.first && active ? "bg-sky-50" : ""}">${label}</div>`;
  }).join("");
  const body = !e.health
    ? `<div class="px-4 py-3 text-sm text-stone-400">Loading…</div>`
    : (rows || `<div class="px-4 py-3 text-sm text-stone-400">No systems</div>`);
  return `
    <div class="w-56 shrink-0 border-r border-stone-200 bg-white flex flex-col">
      <div class="px-4 py-3 flex items-center justify-between border-b border-stone-100">
        <span class="font-semibold text-stone-900">Systems</span>
        <button id="exp-sys-collapse" class="text-stone-400 hover:text-stone-700" title="Collapse">‹</button>
      </div>
      <div id="exp-sys-body" class="overflow-y-auto py-1 flex-1">${body}</div>
    </div>`;
}

export function expTablesCol(e) {
  if (e.tablesCollapsed) {
    return `<div class="w-9 shrink-0 border-r border-stone-200 bg-white flex flex-col items-center pt-3"><button id="exp-tables-expand" class="text-stone-400 hover:text-stone-700" title="Show tables">›</button></div>`;
  }
  // Every system's entities + value objects in one flat list (system order), aligned
  // row-for-row with the Systems column. Each row: a type glyph (entity / value
  // object, explained on hover) + a connection status dot (state explained on hover).
  const entries = expRowEntries(e);
  const total = entries.filter((en) => en.table).length;
  const rows = entries.map((en) => {
    const t = en.table;
    if (!t) return `<div class="h-9 ${en.sep ? "mt-2 border-t border-stone-200" : ""}"></div>`; // spacer for a table-less system
    const sel = t.name === e.entity && en.system.name === e.system;
    return `<button data-exp-esys="${escapeHtml(en.system.name)}" data-exp-entity="${escapeHtml(t.name)}" class="w-full h-9 flex items-center gap-2 px-3 text-sm text-left hover:bg-stone-100 ${en.sep ? "mt-2 border-t border-stone-200" : ""} ${sel ? "bg-sky-50" : ""}">
      ${tableGlyph(t.kind, t.status)}
      <span class="flex-1 truncate ${sel ? "text-sky-700 font-medium" : "text-stone-700"}">${escapeHtml(t.name)}</span>
    </button>`;
  }).join("");
  const body = !e.health
    ? `<div class="px-4 py-3 text-sm text-stone-400">Loading…</div>`
    : (rows || `<div class="px-4 py-3 text-sm text-stone-400">No tables</div>`);
  return `
    <div class="w-80 shrink-0 border-r border-stone-200 bg-white flex flex-col">
      <div class="px-4 py-3 border-b border-stone-100 flex items-center justify-between">
        <span class="font-semibold text-stone-900">Tables <span class="text-stone-400 font-normal">(${total})</span></span>
        <button id="exp-tables-collapse" class="text-stone-400 hover:text-stone-700" title="Collapse">‹</button>
      </div>
      <div id="exp-tables-body" class="overflow-y-auto py-1 flex-1">${body}</div>
    </div>`;
}

// Provenance → dot colour for the per-row event chips (same scheme as the table
// status dots: live = emerald, recorded = violet, simulated = sky).
export const EVENT_PROV_DOT = { live: "bg-emerald-500", recorded: "bg-violet-500", simulated: "bg-sky-500" };
export const EVENT_PROV_LABEL = { live: "Live", recorded: "Recorded", simulated: "Simulated" };

// One event chip: name + provenance dot + business time, with a hover title
// spelling out provenance, role, evidence, and time.
export function eventChip(ev) {
  const prov = ev.provenance || "simulated";
  const when = ev.businessAt || ev.occurredAt;
  const tip = [
    `${EVENT_PROV_LABEL[prov] || prov} event`,
    ev.role ? `Role: ${ev.role}` : "",
    ev.evidence ? `Evidence: ${ev.evidence}` : "",
    when ? `When: ${formatVersionDate(when)}` : "",
  ].filter(Boolean).join(" · ");
  const time = when ? `<span class="text-stone-400 ml-0.5 shrink-0">${escapeHtml(formatVersionDate(when))}</span>` : "";
  return `<span title="${escapeHtml(tip)}" class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-stone-200 bg-white text-[11px] text-stone-700 max-w-full">
    <span class="w-1.5 h-1.5 rounded-full shrink-0 ${EVENT_PROV_DOT[prov] || EVENT_PROV_DOT.simulated}"></span>
    <span class="font-medium truncate">${escapeHtml(ev.eventName)}</span>${time}
  </span>`;
}

// The rightmost "Events" cell for a row when the toggle is on: the row's events
// stacked vertically (one chip per line). A single event keeps the row near its
// normal height; more events grow the row to fit. Busy/empty states keep the
// cell from looking broken while the trail is loading or genuinely empty.
export function rowEventsCell(events, busy) {
  let inner;
  if (busy && (!events || !events.length)) {
    inner = '<span class="text-[11px] text-stone-400 italic">Loading…</span>';
  } else if (!events || !events.length) {
    inner = '<span class="text-[11px] text-stone-400 italic">No events fired</span>';
  } else {
    inner = events.map(eventChip).join("");
  }
  return `<td class="px-3 py-2 align-top border-l border-stone-100"><div class="flex flex-col items-start gap-1">${inner}</div></td>`;
}

// Internal columns of a gen_ table that are pure infrastructure (provenance,
// tenancy) — never rendered. Everything else, INCLUDING id/version/createdAt/
// updatedAt, is treated as ordinary data and judged against the model: model it
// and it goes green; leave it undeclared and it shows amber like any other column.
export const EXP_HIDDEN_COLS = new Set(["_provenance", "organization_id"]);

// Header styling per column state (see expColumns).
export const EXP_COL_STYLE = {
  green: { text: "text-emerald-700", dot: "bg-emerald-500", title: "In the model and the data" },
  ghost: { text: "text-violet-600", dot: "bg-violet-400", title: "In the model but not in the data — the connector isn't populating this attribute" },
  amber: { text: "text-amber-700", dot: "bg-amber-500", title: "In the data but not in the model — either drift (a renamed/removed attribute) or a column you haven't modelled yet" },
  neutral: { text: "text-stone-500", dot: "bg-stone-300", title: "No model to compare against" },
};

// The Items grid colours columns by comparing the model entity to the REAL
// ingested data columns, across the model×data matrix (three states):
//   green – in the model AND in the data (a populated model attribute)
//   ghost – in the model but NOT in the data (a modelled attribute the connector
//           isn't populating — e.g. a field just added to the model)
//   amber – in the data but NOT in the model (drift — a renamed/removed
//           attribute — OR a column like id/version/createdAt/updatedAt you
//           simply haven't modelled yet: add it to the model and it turns green)
// There is no special "platform" exemption — id/version/createdAt/updatedAt are
// ordinary, model-able attributes. Only `_provenance`/`organization_id` are
// hidden (pure infra). With no model entity to compare against (an unmodelled raw
// table) every column is "neutral" — nothing is stale without a model.
// Returns [{ name, state }] ordered id → model attributes (green/ghost in model
// order) → remaining data columns (amber).
export function expColumns(e, entity) {
  const modelFields = entity && entity.fields ? entity.fields.map((f) => f.name) : [];
  const modelSet = new Set(modelFields);
  const hasModel = modelSet.size > 0;
  // "In the data" means at least one row carries a real value. Adding a field to
  // the model ALTERs the gen_ table to add an all-NULL column, so a column can
  // exist on every row yet never be populated — that's ghost (modelled, not
  // filled), not green. Mirrors the empty-cell test in the body renderer.
  const dataKeys = new Set();
  for (const r of (e.items || [])) for (const k of Object.keys(r)) {
    if (EXP_HIDDEN_COLS.has(k)) continue;
    const v = r[k];
    if (v !== null && v !== undefined && v !== "") dataKeys.add(k);
  }
  const stateOf = (name) => {
    if (!hasModel) return "neutral";                              // nothing to compare against
    if (modelSet.has(name)) return dataKeys.has(name) ? "green" : "ghost";
    return "amber";                                               // in data, not in model (incl. unmodelled id/version/createdAt/…)
  };
  const out = [];
  const seen = new Set();
  const push = (name) => { if (!seen.has(name)) { seen.add(name); out.push({ name, state: stateOf(name) }); } };
  if (dataKeys.has("id") || modelSet.has("id")) push("id");        // identifier first
  for (const f of modelFields) push(f);                           // model attributes: green (in data) or ghost (missing)
  for (const k of dataKeys) if (!modelSet.has(k)) push(k);        // everything else in the data (amber)
  return out.length ? out : [{ name: "id", state: "neutral" }];
}

export function expMain(e) {
  if (!e.system) return `<div class="flex-1 flex items-center justify-center text-stone-400 text-sm">Loading systems…</div>`;
  if (!e.entity) return `<div class="flex-1 flex items-center justify-center text-stone-400 text-sm">Select a table to explore its items.</div>`;
  const entity = (e.entities || []).find((t) => t.name === e.entity) || (e.valueObjects || []).find((t) => t.name === e.entity);
  const cols = expColumns(e, entity);
  const hasModel = !!(entity && entity.fields && entity.fields.length);
  const legend = hasModel ? `
      <div class="px-6 pb-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-stone-500">
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>In model &amp; data</span>
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-1.5 h-1.5 rounded-full bg-violet-400"></span>In model, no data <span class="italic">(not populated)</span></span>
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"></span>In data, not in model <span class="italic">(stale / unmodelled)</span></span>
      </div>` : "";
  const rows = applyExpFilters(e.items, e.filters);
  const tableAdapters = expAdaptersForEntity(e);
  const PAGE = 25;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const page = Math.min(e.page, pages - 1);
  const pageRows = rows.slice(page * PAGE, page * PAGE + PAGE);
  const headerCells = cols.map((c) => {
    const st = EXP_COL_STYLE[c.state] || EXP_COL_STYLE.neutral;
    return `<th class="px-3 py-2 text-left text-[11px] font-semibold ${st.text} whitespace-nowrap border-b border-stone-200" title="${st.title}"><span class="inline-flex items-center gap-1.5"><span class="inline-block w-1.5 h-1.5 rounded-full ${st.dot}"></span>${escapeHtml(c.name)}</span></th>`;
  }).join("")
    + `<th class="px-3 py-2 text-left text-[11px] font-semibold text-stone-600 whitespace-nowrap border-b border-stone-200 border-l border-stone-100">⚡ Events</th>`;
  // The events column is always on, so top-align every cell — a row that grows to
  // fit several stacked events keeps its other values lined up at the top.
  const tdAlign = "align-top";
  const bodyRows = pageRows.map((r) => `<tr class="hover:bg-stone-50 border-b border-stone-100">
      <td class="px-3 py-2 ${tdAlign}"><input type="checkbox" class="rounded border-stone-300" /></td>
      ${cols.map((col, ci) => {
        const val = r[col.name];
        const empty = val === null || val === undefined || val === "";
        const s = empty ? "" : String(val);
        const disp = empty ? '<span class="text-stone-300">—</span>' : escapeHtml(s.length > 44 ? s.slice(0, 44) + "…" : s);
        return `<td class="px-3 py-2 text-sm whitespace-nowrap ${tdAlign} ${ci === 0 ? "text-sky-700 font-medium mono text-xs" : "text-stone-700"}">${disp}</td>`;
      }).join("")}
      ${rowEventsCell(e.rowEvents[r.id], e.rowEventsBusy)}
    </tr>`).join("");
  return `
    <div class="flex-1 flex flex-col min-w-0 bg-white">
      <div class="px-6 py-4 flex items-center justify-between border-b border-stone-200">
        <div class="text-xl font-semibold text-stone-900">${escapeHtml(e.entity)}</div>
        <div class="flex items-center gap-2">
          <button id="exp-fetch-rows" ${e.busy || !tableAdapters.length ? "disabled" : ""} class="px-4 py-1.5 text-sm rounded-full border border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50 disabled:opacity-40 font-medium" title="${tableAdapters.length ? `Pull up to 1000 rows from ${escapeHtml(tableAdapters[0].id)}` : "No connector configured for this table"}">Fetch rows</button>
          <button id="exp-clear-rows" ${e.busy ? "disabled" : ""} class="px-4 py-1.5 text-sm rounded-full border border-rose-300 bg-white text-rose-800 hover:bg-rose-50 disabled:opacity-40 font-medium" title="Delete every row in this table and the simulated events derived from it (connectors are kept)">Delete all rows</button>
          <button id="exp-reimport-all" ${e.busy ? "disabled" : ""} class="px-4 py-1.5 text-sm rounded-full border border-rose-300 bg-white text-rose-800 hover:bg-rose-50 disabled:opacity-40 font-medium" title="Empty EVERY base-data table and the entire event log (all systems), then re-pull every connector to reimport the base data from source">Reset &amp; reimport base data</button>
          <button id="exp-config-adapter" class="px-4 py-1.5 text-sm rounded-full border ${state.chatOpen && e.panelMode === "history" ? "border-sky-400 bg-sky-50 text-sky-700" : "border-sky-300 bg-white text-sky-700 hover:bg-sky-50"} font-medium">Configure connector</button>
        </div>
      </div>
      <div class="px-6 py-3 border-b border-stone-200">${expFiltersPanel(e, cols)}</div>
      <div class="px-6 pt-3 pb-1 flex items-center justify-between">
        <div class="text-sm font-semibold text-stone-800">Table: ${escapeHtml(e.entity)} — Items returned <span class="text-stone-400 font-normal">(${rows.length})</span></div>
        <div class="flex items-center gap-2 text-sm text-stone-500">
          <button id="exp-prev" class="px-2 py-0.5 rounded hover:bg-stone-100 ${page <= 0 ? "opacity-40" : ""}">‹</button>
          <span class="tabular-nums">${page + 1} / ${pages}</span>
          <button id="exp-next" class="px-2 py-0.5 rounded hover:bg-stone-100 ${page >= pages - 1 ? "opacity-40" : ""}">›</button>
        </div>
      </div>
      ${legend}
      <div class="flex-1 overflow-auto px-6 pb-6">
        ${e.busy ? '<div class="text-stone-400 text-sm py-10 text-center">Loading…</div>'
          : e.tableMissing ? `<div class="text-stone-400 text-sm py-10 text-center">No data yet for <b>${escapeHtml(e.entity)}</b>. Run the simulator or configure a connector to populate it.</div>`
          : rows.length === 0 ? '<div class="text-stone-400 text-sm py-10 text-center">No items match the filters.</div>'
          : `<div class="rounded-lg border border-stone-200 overflow-x-auto">
              <table class="min-w-full">
                <thead class="bg-stone-50"><tr><th class="px-3 py-2 w-8 border-b border-stone-200"></th>${headerCells}</tr></thead>
                <tbody>${bodyRows}</tbody>
              </table>
            </div>`}
      </div>
    </div>`;
}

export function expFiltersPanel(e, cols) {
  const conds = ["Equal to", "Not equal to", "Contains", "Begins with", "Greater than", "Less than"];
  const types = ["String", "Number"];
  const filterRows = (e.filters || []).map((f, i) => `
    <div class="flex items-end gap-2 mb-2">
      <div class="flex-1"><label class="block text-[11px] text-stone-500 mb-0.5">Attribute name</label>
        <input data-filter-idx="${i}" data-filter-field="attr" list="exp-attr-list" value="${escapeHtml(f.attr || "")}" placeholder="Enter attribute name" class="w-full text-sm border border-stone-300 rounded-md px-2 py-1.5" /></div>
      <div><label class="block text-[11px] text-stone-500 mb-0.5">Condition</label>
        <select data-filter-idx="${i}" data-filter-field="cond" class="text-sm border border-stone-300 rounded-md px-2 py-1.5">${conds.map((c) => `<option ${c === f.cond ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      <div><label class="block text-[11px] text-stone-500 mb-0.5">Type</label>
        <select data-filter-idx="${i}" data-filter-field="type" class="text-sm border border-stone-300 rounded-md px-2 py-1.5">${types.map((t) => `<option ${t === f.type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="flex-1"><label class="block text-[11px] text-stone-500 mb-0.5">Value</label>
        <input data-filter-idx="${i}" data-filter-field="value" value="${escapeHtml(f.value || "")}" placeholder="Enter attribute value" class="w-full text-sm border border-stone-300 rounded-md px-2 py-1.5" /></div>
      <button data-filter-remove="${i}" class="px-3 py-1.5 text-sm text-sky-700 hover:underline whitespace-nowrap">Remove</button>
    </div>`).join("");
  return `
    <details ${e.filters && e.filters.length ? "open" : ""}>
      <summary class="text-sm font-medium text-stone-700 cursor-pointer select-none mb-2">Filters <span class="text-stone-400 font-normal italic">– optional</span></summary>
      <datalist id="exp-attr-list">${cols.map((c) => `<option value="${escapeHtml(c.name)}">`).join("")}</datalist>
      ${filterRows}
      <button id="exp-add-filter" class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 mb-1">Add filter</button>
      <div class="flex items-center gap-3 mt-1">
        <button id="exp-run" class="px-5 py-1.5 text-sm rounded-full bg-amber-400 hover:bg-amber-500 text-stone-900 font-semibold">Run</button>
        <button id="exp-reset" class="text-sm text-sky-700 hover:underline">Reset</button>
      </div>
    </details>`;
}

// Colour chip per update-note kind (for the connector doc timeline).
export const NOTE_BADGE = {
  created: "bg-sky-100 text-sky-800",
  built: "bg-emerald-100 text-emerald-800",
  edited: "bg-lime-100 text-lime-800",
  repaired: "bg-amber-100 text-amber-800",
  credentials: "bg-violet-100 text-violet-800",
  ingested: "bg-teal-100 text-teal-800",
  cleared: "bg-orange-100 text-orange-800",
  repointed: "bg-indigo-100 text-indigo-800",
  removed: "bg-rose-100 text-rose-800",
  note: "bg-stone-100 text-stone-700",
};

// kebab-slug, byte-for-byte the backend's connector-id minting (orchestrate.ts slug()).
export function connectorSlug(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
}

// A connector's DISPLAY name. The id is an immutable persistence key (filename,
// journal key, registry id) minted ONCE from system+table; a re-point changes the
// target but deliberately freezes the id, so rendering the raw id reads as a stale
// "wrong table" name. Derive the name from the CURRENT target instead — but only
// for auto-minted ids (which carry the system slug as a prefix). A custom id is the
// user's chosen name and is left untouched. bcFallback covers callers (the sidebar
// card) whose object may not carry boundedContext but whose system is known.
export function connectorName(c, bcFallback) {
  const bc = c.boundedContext || bcFallback || "";
  const id = c.id || "";
  return id.startsWith(connectorSlug(bc) + "-") ? connectorSlug(`${bc}-${c.targetEntity}`) : id;
}

// One connector card: name + shape, the doc summary, and the most recent update
// notes (newest first). doc rides along on the adapter from /api/bc/:bc. `bc` is
// the selected system, used to derive the live name when re-pointing renamed it.
export function connectorCard(a, bc) {
  const doc = a.doc;
  const summary = doc?.summary
    ? `<div class="text-xs text-stone-600 mt-1 italic">${escapeHtml(doc.summary)}</div>`
    : "";
  const notes = (doc?.notes || []).slice(-6).reverse();
  const notesHtml = notes.length
    ? `<div class="mt-2 border-t border-stone-100 pt-2 space-y-1.5">
        ${notes.map((n) => `<div class="flex items-baseline gap-1.5 text-[11px]">
          <span class="px-1 py-0.5 rounded ${NOTE_BADGE[n.kind] || NOTE_BADGE.note} shrink-0">${escapeHtml(n.kind)}</span>
          <span class="flex-1 text-stone-600">${escapeHtml(n.text)}</span>
          <span class="text-stone-400 shrink-0">${escapeHtml(formatVersionDate(n.at))}</span>
        </div>`).join("")}
      </div>`
    : "";
  // Connector-scoped management (re-point, timestamps, full history, delete) lives
  // on the Connectors tab — its single home. The card deep-links there for THIS
  // connector instead of duplicating those controls (especially destructive delete)
  // in the sidebar. Authoring stays here; operating happens there.
  const manageLink = a.kind === "connector"
    ? `<div class="mt-2 pt-2 border-t border-stone-100 text-right">
        <a href="#connectors/${encodeURIComponent(a.id)}" class="text-[11px] text-sky-700 hover:text-sky-800 hover:underline" title="Open this connector in the Connectors tab to re-point it, set event timestamps, view its full history, or delete it.">Manage in Connectors →</a>
      </div>`
    : "";
  return `<div class="rounded-md border border-stone-200 p-2.5">
    <div class="text-sm font-medium text-stone-800">${escapeHtml(connectorName(a, bc))}</div>
    <div class="text-xs text-stone-500 mt-0.5">${escapeHtml(a.kind)} · ${escapeHtml(a.mode)} → ${escapeHtml(a.targetEntity)}</div>
    ${summary}${notesHtml}${manageLink}
  </div>`;
}

// The History tab body of the connector sidebar (rendered inside chatPanel's
// fixed aside, so NO outer panel here). Scoped to the SELECTED table (entity/VO)
// to match the per-(system,table) chat thread: shows the connector(s) targeting
// it with their summary + update-notes timeline, plus the Build-with-AI call to
// action (which flips the same panel to the Chat tab).
export function connectorHistoryBody(e) {
  const adapters = (e.adapters || []).filter((a) => a.targetEntity === e.entity);
  const list = adapters.length
    ? adapters.map((a) => connectorCard(a, e.system)).join("")
    : '<div class="text-sm text-stone-400">No connector yet for this table — build one below.</div>';
  return `
    <div class="p-4 overflow-y-auto flex-1 space-y-3">
      <div class="text-xs text-stone-500">System <b>${escapeHtml(e.system || "")}</b> → ${expKindOf(e, e.entity) === "valueObject" ? "value object" : "table"} <b>${escapeHtml(e.entity || "")}</b></div>
      ${list}
      <div class="rounded-lg border border-sky-200 bg-sky-50/60 p-4 text-center">
        <div class="text-2xl mb-1">✨</div>
        <div class="text-sm font-medium text-stone-800">Build a connector with AI</div>
        <div class="text-xs text-stone-500 mt-1">Describe any source — DynamoDB, a REST API, Postgres, a Google Sheet — and the assistant writes, tests, and runs a connector to fill this table.</div>
        <button id="exp-build-ai" class="w-full mt-3 px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 font-medium">Build connector with AI →</button>
      </div>
    </div>`;
}

// A shared, instant-opening tooltip with two labelled sections (Type / Status).
// Lives on <body> (a sibling of #app) so it survives re-renders and isn't clipped
// by the columns' overflow. Wired once via event delegation on data-tip-* elements.
let _tipReady = false;
export function initTooltips() {
  if (_tipReady) return;
  _tipReady = true;
  const tip = document.createElement("div");
  tip.id = "app-tip";
  tip.className = "fixed z-50 hidden w-64 rounded-lg border border-stone-200 bg-white shadow-xl text-xs overflow-hidden pointer-events-none";
  tip.innerHTML = `
    <div class="px-3 py-2 border-b border-stone-100">
      <div class="text-[10px] uppercase tracking-widest text-stone-400 mb-0.5">Type</div>
      <div class="text-stone-700 leading-snug" data-tip-slot="type"></div>
    </div>
    <div class="px-3 py-2">
      <div class="text-[10px] uppercase tracking-widest text-stone-400 mb-0.5">Status</div>
      <div class="text-stone-700 leading-snug" data-tip-slot="status"></div>
    </div>`;
  document.body.appendChild(tip);
  const typeSlot = tip.querySelector('[data-tip-slot="type"]');
  const statusSlot = tip.querySelector('[data-tip-slot="status"]');
  const place = (el) => {
    tip.classList.remove("hidden");
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = r.right + 8;
    if (left + tw > window.innerWidth - 8) left = r.left - tw - 8; // flip left on overflow
    left = Math.max(8, left);
    let top = Math.max(8, Math.min(r.top + r.height / 2 - th / 2, window.innerHeight - th - 8));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  document.addEventListener("mouseover", (ev) => {
    const el = ev.target.closest?.("[data-tip-type]");
    if (!el) return;
    typeSlot.textContent = el.dataset.tipType || "";
    statusSlot.textContent = el.dataset.tipStatus || "";
    place(el);
  });
  document.addEventListener("mouseout", (ev) => {
    const el = ev.target.closest?.("[data-tip-type]");
    if (!el) return;
    if (ev.relatedTarget && el.contains(ev.relatedTarget)) return; // moved within the same trigger
    tip.classList.add("hidden");
  });
}

export function bindExplorer() {
  initTooltips();
  document.getElementById("exp-sys-collapse")?.addEventListener("click", () => { expState().sysCollapsed = true; render(); });
  document.getElementById("exp-sys-expand")?.addEventListener("click", () => { expState().sysCollapsed = false; render(); });
  document.getElementById("exp-tables-collapse")?.addEventListener("click", () => { expState().tablesCollapsed = true; render(); });
  document.getElementById("exp-tables-expand")?.addEventListener("click", () => { expState().tablesCollapsed = false; render(); });
  document.querySelectorAll("[data-exp-sys]").forEach((el) => el.addEventListener("click", () => selectExpSystem(el.dataset.expSys)));
  // A table row carries its own system (data-exp-esys); switch systems first when
  // the clicked table belongs to a different one than the active selection.
  document.querySelectorAll("[data-exp-entity]").forEach((el) => el.addEventListener("click", () => {
    const e = expState(), sys = el.dataset.expEsys, name = el.dataset.expEntity;
    if (sys && sys !== e.system) selectExpSystem(sys, name); else selectExpEntity(name);
  }));
  // Keep the Systems and Tables columns vertically aligned while scrolling, so each
  // system name stays level with its first table even past the fold.
  const sysBody = document.getElementById("exp-sys-body");
  const tblBody = document.getElementById("exp-tables-body");
  if (sysBody && tblBody) {
    let syncing = false;
    const link = (from, to) => from.addEventListener("scroll", () => {
      if (syncing) return; syncing = true; to.scrollTop = from.scrollTop; syncing = false;
    });
    link(sysBody, tblBody); link(tblBody, sysBody);
  }
  // Filter inputs update state quietly (no re-render → no focus loss); Run applies.
  document.querySelectorAll("[data-filter-idx]").forEach((el) => {
    const i = Number(el.dataset.filterIdx), field = el.dataset.filterField;
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", (ev) => { expState().filters[i][field] = ev.target.value; });
  });
  document.querySelectorAll("[data-filter-remove]").forEach((el) => el.addEventListener("click", () => { expState().filters.splice(Number(el.dataset.filterRemove), 1); render(); }));
  document.getElementById("exp-add-filter")?.addEventListener("click", () => { expState().filters.push({ attr: "", cond: "Equal to", type: "String", value: "" }); render(); });
  document.getElementById("exp-run")?.addEventListener("click", () => { expState().page = 0; render(); });
  document.getElementById("exp-reset")?.addEventListener("click", () => { expState().filters = []; expState().page = 0; render(); });
  document.getElementById("exp-prev")?.addEventListener("click", () => { const e = expState(); if (e.page > 0) { e.page--; render(); } });
  document.getElementById("exp-next")?.addEventListener("click", () => { expState().page++; render(); });
  // "Connectors" pill: toggle the single sidebar on its History tab.
  document.getElementById("exp-config-adapter")?.addEventListener("click", () => {
    const e = expState();
    if (state.chatOpen && e.panelMode === "history") { state.chatOpen = false; }
    else { e.panelMode = "history"; state.chatOpen = true; if (!state.chatInfo) loadChatInfo().then(render); }
    render();
  });
  document.getElementById("exp-fetch-rows")?.addEventListener("click", expFetchRows);
  document.getElementById("exp-clear-rows")?.addEventListener("click", expClearRows);
  document.getElementById("exp-reimport-all")?.addEventListener("click", expReimportAll);
  document.getElementById("exp-build-ai")?.addEventListener("click", openConnectorChat);
}

