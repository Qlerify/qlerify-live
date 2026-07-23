// Connectors tab (#connectors) + the lazy Monaco code editor. Extracted from
// app.js — see the section comment below for what this view does.

import { state } from "./state.js";
import { escapeHtml } from "./format.js";
import { api, render } from "./app.js";
import { NOTE_BADGE, connectorName } from "./explorer.js";
import { formatVersionDate } from "./model.js";

// ---------------------------------------------------------------------------
// Connectors tab (#connectors) — workflow-wide inventory of data connectors:
// active + orphaned, with detail, re-point, and delete. This is the ONLY home for
// orphaned connectors (whose target table was renamed/removed), and re-point is
// the deliberate manual recovery path (no automatic rename detection).
// ---------------------------------------------------------------------------

export async function loadConnectors() {
  state.connBusy = true; render();
  try {
    const d = await api("/api/connectors");
    state.connectors = d;
    state.connError = null;
    const ids = (d.connectors || []).map((c) => c.id);
    if (state.connSel && !ids.includes(state.connSel)) state.connSel = null;
    if (!state.connSel && ids.length) state.connSel = ids[0];
  } catch (e) {
    state.connectors = { connectors: [], tables: [] };
    state.connError = e.message;
  } finally {
    state.connBusy = false; render();
  }
}

function connStatusDot(status) {
  return status === "orphaned"
    ? `<span class="inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0" title="Orphaned — target table missing"></span>`
    : `<span class="inline-block w-2 h-2 rounded-full bg-emerald-500 shrink-0" title="Active"></span>`;
}

function connListRow(c) {
  const sel = state.connSel === c.id;
  return `<button data-conn-row="${escapeHtml(c.id)}" class="w-full text-left px-3 py-2.5 border-b border-stone-100 ${sel ? "bg-sky-50" : "hover:bg-stone-50"}">
    <div class="flex items-center gap-2">${connStatusDot(c.status)}<span class="text-sm font-medium text-stone-800 truncate">${escapeHtml(connectorName(c))}</span></div>
    <div class="text-[11px] text-stone-500 mt-0.5 truncate">${escapeHtml(c.boundedContext)} → ${escapeHtml(c.targetEntity)}${c.status === "orphaned" ? " (missing)" : ""} · ${c.rowCount} row(s)</div>
  </button>`;
}

function connDetail(c) {
  if (!c) return `<div class="p-8 text-sm text-stone-400">Select a connector to see its details.</div>`;
  const name = connectorName(c);
  const tables = state.connectors?.tables || [];
  // Re-point options: tables free in this workflow (plus the current target).
  const free = tables.filter((t) => !t.occupiedBy || t.occupiedBy === c.id);
  const opts = free.map((t) => `<option value="${escapeHtml(t.name)}" ${t.name === c.targetEntity ? "selected" : ""}>${escapeHtml(t.name)}${t.kind === "valueObject" ? " (value object)" : ""}${t.name === c.targetEntity ? " — current" : ""}</option>`).join("");
  const notes = (c.notes || []).slice(-8).reverse();
  const notesHtml = notes.length
    ? notes.map((n) => `<div class="flex items-baseline gap-1.5 text-[11px] py-0.5">
        <span class="px-1 py-0.5 rounded ${NOTE_BADGE[n.kind] || NOTE_BADGE.note} shrink-0">${escapeHtml(n.kind)}</span>
        <span class="flex-1 text-stone-600">${escapeHtml(n.text)}</span>
        <span class="text-stone-400 shrink-0">${escapeHtml(formatVersionDate(n.at))}</span>
      </div>`).join("")
    : `<div class="text-xs text-stone-400">No history recorded.</div>`;
  const chip = (label, val) => `<div class="text-[11px]"><span class="text-stone-400">${label}</span> <span class="text-stone-700">${val}</span></div>`;
  const orphan = c.status === "orphaned";
  const dateFields = c.dateFields || [];
  const dr = c.dateRoles || {};
  const dfOpts = (selected) => [
    `<option value="">— none —</option>`,
    ...dateFields.map((f) => `<option value="${escapeHtml(f)}" ${f === selected ? "selected" : ""}>${escapeHtml(f)}</option>`),
  ].join("");
  const timestampsSection = dateFields.length ? `
      <div class="mt-5 rounded-lg border border-stone-200 p-4">
        <div class="text-sm font-medium text-stone-800">Event timestamps</div>
        <div class="text-xs text-stone-500 mt-0.5">Which source columns hold the record's creation and last-modified times. Create events are stamped with <b>Created</b>; update events with <b>Updated</b> — so the timeline follows the data instead of ingestion time. Inferred at build time; override here.</div>
        <div class="grid grid-cols-2 gap-3 mt-3">
          <label class="text-xs text-stone-600 block">Created<select id="conn-date-created" class="mt-1 w-full text-sm rounded-md border border-stone-300 px-2 py-1.5 bg-white">${dfOpts(dr.created)}</select></label>
          <label class="text-xs text-stone-600 block">Updated<select id="conn-date-updated" class="mt-1 w-full text-sm rounded-md border border-stone-300 px-2 py-1.5 bg-white">${dfOpts(dr.updated)}</select></label>
        </div>
        <button id="conn-date-save" ${state.connBusy ? "disabled" : ""} class="mt-3 px-4 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium">Save timestamps</button>
        <div class="text-[11px] text-stone-400 mt-2">New rows pick these up on the next Fetch. Events already in the log keep their old timestamps until you rebuild from data (clears &amp; re-derives the event log).</div>
      </div>` : "";
  // Connection diagnostics (moved here from the retired per-system workbench): the
  // two adapter ops that genuinely work for a connector — Verify (healthcheck) and a
  // dry-run Test (pull + grade against the model, nothing written). Results are kept
  // per-connector (gated by id) so they don't bleed across the list selection.
  const v = state.connVerify?.id === c.id ? state.connVerify : null;
  const t = state.connTest?.id === c.id ? state.connTest : null;
  const verifyStatus = v == null
    ? `<span class="text-stone-400">not checked</span>`
    : `<span class="${v.ok ? "text-emerald-700" : "text-rose-600"}">● ${v.ok ? "connected" : "not connected"}</span>${v.detail ? ` <span class="text-stone-500">${escapeHtml(v.detail)}</span>` : ""}`;
  let testResult = "";
  if (t && !t.error) {
    const checklist = ((t.diff && t.diff.requiredStatus) || []).map((r) =>
      `<span class="inline-flex items-center gap-1 px-2 py-0.5 mr-1 mb-1 rounded text-[11px] ${r.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}">${r.ok ? "✓" : "✗"} ${escapeHtml(r.field)}</span>`).join("");
    const extra = (t.diff && t.diff.extraFields) || [];
    testResult = `<div class="mt-3 space-y-2">
        <div class="text-sm">${t.diff && t.diff.ok ? `<span class="text-emerald-700 font-medium">✓ matches the model</span>` : `<span class="text-rose-600 font-medium">✗ shape mismatch</span>`} <span class="text-stone-500">· ${t.count} row(s) pulled, nothing written</span></div>
        ${checklist ? `<div>${checklist}</div>` : ""}
        ${extra.length ? `<div class="text-[11px] text-amber-700">extra unmapped fields: ${extra.map(escapeHtml).join(", ")}</div>` : ""}
      </div>`;
  } else if (t && t.error) {
    testResult = `<div class="mt-3 text-rose-600 text-sm">${escapeHtml(t.error)}</div>`;
  }
  const diagnostics = `
      <div class="mt-5 rounded-lg border border-stone-200 p-4">
        <div class="text-sm font-medium text-stone-800">Connection</div>
        <div class="text-xs text-stone-500 mt-0.5">Check the live source is reachable, and dry-run a pull to grade the data against the model — without writing anything.</div>
        <div class="flex items-center gap-2 mt-3 flex-wrap">
          <button id="conn-verify" ${state.connBusy ? "disabled" : ""} class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium">Verify connection</button>
          <button id="conn-test" ${state.connBusy ? "disabled" : ""} class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium">Test (dry run)</button>
          <span class="text-sm">${verifyStatus}</span>
        </div>
        ${testResult}
      </div>`;
  // Details | Code tabs. The header (name/status/summary) stays put above both; the
  // body below switches. "code" mounts the Monaco editor (see mountConnCode).
  const tab = state.connTab === "code" ? "code" : "details";
  const tabBtn = (id, label) => `<button data-conn-tab="${id}" class="px-3 py-1.5 text-sm rounded-md font-medium ${tab === id ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}">${label}</button>`;
  const detailsBody = `
      <div class="p-6 overflow-y-auto flex-1">
        <div class="grid grid-cols-2 gap-x-6 gap-y-1">
          ${chip("System", escapeHtml(c.boundedContext))}
          ${chip("Table", `${escapeHtml(c.targetEntity)} (${escapeHtml(c.targetKind)})`)}
          ${chip("Mode", escapeHtml(c.mode))}
          ${chip("Rows", String(c.rowCount))}
          ${chip("Code", c.hasCode ? "built" : "none")}
          ${chip("Credentials", c.credentialKeys.length ? escapeHtml(c.credentialKeys.join(", ")) : "none")}
          ${chip("Packages", c.deps.length ? escapeHtml(c.deps.join(", ")) : "none")}
          ${chip("Endpoint", c.endpoint ? escapeHtml(c.endpoint) : "—")}
          ${chip("Last pull", c.lastPullAt ? escapeHtml(formatVersionDate(c.lastPullAt)) : "never")}
          ${c.owned ? "" : chip("Owner", "legacy (unassigned)")}
        </div>
${diagnostics}
        <div class="mt-5 rounded-lg border border-stone-200 p-4">
          <div class="text-sm font-medium text-stone-800">Re-point</div>
          <div class="text-xs text-stone-500 mt-0.5">Point this connector at a different table. Going forward only — existing rows in the old table stay put; the connector fills the new table on the next Fetch.</div>
          <div class="flex items-center gap-2 mt-3">
            <select id="conn-repoint-target" class="flex-1 text-sm rounded-md border border-stone-300 px-2 py-1.5 bg-white">${opts}</select>
            <button id="conn-repoint-btn" ${state.connBusy ? "disabled" : ""} class="px-4 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium">Re-point</button>
          </div>
        </div>
${timestampsSection}
        <div class="mt-4">
          <div class="text-[11px] font-medium text-stone-500 uppercase tracking-wide mb-1">History</div>
          <div class="rounded-lg border border-stone-100 p-3 space-y-0.5">${notesHtml}</div>
        </div>

        <div class="mt-5 rounded-lg border border-rose-200 bg-rose-50/40 p-4">
          <div class="text-sm font-medium text-rose-800">Danger zone</div>
          <div class="text-xs text-stone-600 mt-0.5">Completely delete this connector — its code, credentials, ingested data, derived events, and history. Cannot be undone.</div>
          <button id="conn-delete-btn" ${state.connBusy ? "disabled" : ""} class="mt-3 px-4 py-1.5 text-sm rounded-md border border-rose-300 bg-white text-rose-700 hover:bg-rose-100 disabled:opacity-40 font-medium">🗑 Delete connector</button>
        </div>
      </div>`;
  return `
    <div class="flex flex-col flex-1 min-h-0">
      <div class="px-6 pt-6 pb-3 border-b border-stone-200">
        <div class="flex items-center gap-2">
          ${connStatusDot(c.status)}
          <h2 class="text-xl font-semibold text-stone-900">${escapeHtml(name)}</h2>
          <span class="px-2 py-0.5 text-[11px] rounded-full ${orphan ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}">${orphan ? "orphaned" : "active"}</span>
        </div>
        <div class="flex items-center gap-3 mt-1 text-[11px]">
          ${name !== c.id ? `<span class="text-stone-400" title="The connector's immutable id (its storage key). Re-pointing renamed it above, but the id never changes.">key <span class="font-mono text-stone-500">${escapeHtml(c.id)}</span></span>` : ""}
          ${orphan ? "" : `<a href="#bcs/${encodeURIComponent(c.boundedContext)}/${encodeURIComponent(c.targetEntity)}" class="text-sky-700 hover:underline">Open table &amp; data →</a>`}
        </div>
        ${c.summary
          ? `<div class="text-sm text-stone-600 mt-2 italic">${escapeHtml(c.summary)}</div>`
          : `<div class="text-sm text-stone-400 mt-2 italic">No description yet — build the connector to generate one.</div>`}
        ${orphan ? `<div class="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">Its target table <b>${escapeHtml(c.targetEntity)}</b> no longer exists in the model — likely renamed or removed. It can't ingest until you <b>re-point</b> it at a current table (or delete it).</div>` : ""}
        <div class="flex items-center gap-1 mt-4">${tabBtn("details", "Details")}${tabBtn("code", "Code")}</div>
      </div>
      ${tab === "code" ? connCodeBody(c) : detailsBody}
    </div>`;
}

// The Code tab body: a toolbar (Revert / Save / dirty status) over a full-height
// mount for the Monaco editor. The mount starts EMPTY — Monaco is loaded lazily and
// attached imperatively by mountConnCode() after render, so the heavy editor library
// only loads when a user actually opens this tab, and the live editor instance can
// survive the app's full-innerHTML re-renders (its host node is re-parented, not
// rebuilt). `relative` so the absolutely-positioned editor host fills it.
function connCodeBody(c) {
  return `
      <div class="flex flex-col flex-1 min-h-0">
        <div class="flex items-center gap-2 px-6 py-2 border-b border-stone-200 bg-stone-50">
          <span class="text-xs text-stone-500 truncate">Runs in the connector sandbox on <b>Test</b> / <b>Fetch</b>. Saving installs any npm packages it imports — it does not pull data.</span>
          <span id="conn-code-status" class="text-xs text-stone-400 ml-auto shrink-0">Saved</span>
          <button id="conn-code-revert" class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium shrink-0">Revert</button>
          <button id="conn-code-save" disabled class="px-4 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium shrink-0">Save</button>
        </div>
        <div id="conn-code-mount" class="flex-1 min-h-0 relative bg-[#1e1e1e]"></div>
      </div>`;
}

export function connectorsView() {
  const data = state.connectors || { connectors: [], tables: [] };
  const list = data.connectors || [];
  if (state.connError) return `<main class="p-8"><div class="text-rose-600 text-sm">${escapeHtml(state.connError)}</div></main>`;
  if (!list.length) {
    return `<main class="flex-1 flex items-center justify-center p-10">
      <div class="text-center max-w-md">
        <div class="text-3xl mb-2">🔌</div>
        <div class="text-lg font-semibold text-stone-800">No connectors yet</div>
        <div class="text-sm text-stone-500 mt-1">Build one in <a href="#bcs" class="text-sky-700 hover:underline">Systems</a>: pick a table and choose “Build connector with AI”. Connectors show up here for management and re-pointing.</div>
      </div>
    </main>`;
  }
  const orphaned = list.filter((c) => c.status === "orphaned");
  const active = list.filter((c) => c.status !== "orphaned");
  const sel = list.find((c) => c.id === state.connSel) || null;
  const section = (title, items, tone) => items.length
    ? `<div class="px-3 py-1.5 text-[11px] uppercase tracking-wide ${tone} bg-stone-50 border-b border-stone-200">${title} (${items.length})</div>${items.map(connListRow).join("")}`
    : "";
  return `
    <main class="flex-1 flex min-h-0">
      <div class="w-[340px] border-r border-stone-200 overflow-y-auto bg-white">
        ${section("Needs attention", orphaned, "text-rose-600 font-semibold")}
        ${section("Active", active, "text-stone-500")}
      </div>
      <div class="flex-1 flex flex-col min-w-0 bg-white">${connDetail(sel)}</div>
    </main>`;
}

export function bindConnectors() {
  document.querySelectorAll("[data-conn-row]").forEach((el) =>
    el.addEventListener("click", () => { state.connSel = el.dataset.connRow; render(); }));
  document.querySelectorAll("[data-conn-tab]").forEach((el) =>
    el.addEventListener("click", () => { state.connTab = el.dataset.connTab; render(); }));
  document.getElementById("conn-repoint-btn")?.addEventListener("click", connRepoint);
  document.getElementById("conn-date-save")?.addEventListener("click", connSaveDateRoles);
  document.getElementById("conn-verify")?.addEventListener("click", connVerify);
  document.getElementById("conn-test")?.addEventListener("click", connTest);
  document.getElementById("conn-delete-btn")?.addEventListener("click", connDelete);
  document.getElementById("conn-code-save")?.addEventListener("click", connCodeSave);
  document.getElementById("conn-code-revert")?.addEventListener("click", connCodeRevert);
  mountConnCode(); // (re)attach or lazily build the Monaco editor if the Code tab is open
}

// --- Connector Code tab: lazy Monaco editor -------------------------------------
// Monaco is heavy and only needed here, so it's loaded on demand and its live
// instance is preserved across the app's full-innerHTML re-renders by re-parenting
// the editor's host node (rather than recreating the editor each render).

// The live editor: { editor, host, connId, savedCode } or null. `host` is a detached-
// able div Monaco mounts into; we move it between successive #conn-code-mount nodes.
let connMonaco = null;
let connMonacoBusy = false;   // guards against concurrent (re)builds while loading
let monacoLoaderPromise = null;

function makeNode(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// Load Monaco's self-hosted AMD bundle once. The manifest (served by our backend)
// supplies the same-origin loader/vs paths and the content-hashed base-worker URL,
// so nothing is hardcoded across Monaco upgrades. Returns window.monaco.
function loadMonaco() {
  if (window.monaco) return Promise.resolve(window.monaco);
  if (monacoLoaderPromise) return monacoLoaderPromise;
  monacoLoaderPromise = (async () => {
    const man = await api("/vendor/monaco/manifest.json");
    if (man.editorWorkerUrl) {
      // Only the base editor worker routes through MonacoEnvironment; the language
      // workers (ts/json/css/html) self-resolve relative to vsPath.
      window.MonacoEnvironment = { getWorkerUrl: () => man.editorWorkerUrl };
    }
    await loadScriptOnce(man.loaderUrl);
    window.require.config({ paths: { vs: man.vsPath } });
    await new Promise((resolve, reject) => {
      try { window.require(["vs/editor/editor.main"], resolve, reject); }
      catch (e) { reject(e); }
    });
    return window.monaco;
  })().catch((e) => { monacoLoaderPromise = null; throw e; });
  return monacoLoaderPromise;
}

export function disposeConnMonaco() {
  if (connMonaco?.editor) { try { connMonaco.editor.dispose(); } catch { /* ignore */ } }
  connMonaco = null;
}

// Called after every connectors-view render. Re-attaches an existing editor for the
// selected connector, or lazily builds one. No-op unless the Code tab is showing.
async function mountConnCode() {
  const mount = document.getElementById("conn-code-mount");
  const c = currentConn();
  if (!mount || !c) return;

  // Same connector as the live editor → just re-parent its host into the fresh
  // mount node and re-layout. Preserves unsaved edits, cursor, and scroll position.
  if (connMonaco && connMonaco.connId === c.id && connMonaco.host) {
    if (connMonaco.host.parentElement !== mount) mount.replaceChildren(connMonaco.host);
    connMonaco.editor?.layout();
    updateConnCodeStatus();
    return;
  }
  if (connMonacoBusy) return;
  connMonacoBusy = true;
  disposeConnMonaco(); // different connector (or none) — start clean

  mount.replaceChildren(makeNode("div", "absolute inset-0 flex items-center justify-center text-sm text-stone-400", "Loading editor…"));
  try {
    const monaco = await loadMonaco();
    const data = await api(`/api/connectors/${encodeURIComponent(c.id)}/code`);
    // The view may have changed while we awaited — bail if we're no longer on this
    // connector's Code tab.
    const live = document.getElementById("conn-code-mount");
    if (!live || state.view !== "connectors" || state.connTab !== "code" || state.connSel !== c.id) return;
    const host = makeNode("div", "absolute inset-0");
    live.replaceChildren(host);
    const editor = monaco.editor.create(host, {
      value: data.code || "",
      language: "javascript",
      theme: "vs-dark",
      automaticLayout: true,
      readOnly: false,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: "selection",
    });
    connMonaco = { editor, host, connId: c.id, savedCode: data.code || "" };
    editor.onDidChangeModelContent(() => updateConnCodeStatus());
    updateConnCodeStatus();
  } catch (e) {
    const live = document.getElementById("conn-code-mount");
    if (live) live.replaceChildren(makeNode("div", "absolute inset-0 p-6 text-sm text-rose-600 bg-white", "Couldn't load the code editor: " + (e?.message || e)));
  } finally {
    connMonacoBusy = false;
  }
}

// Reflect dirty state in the toolbar WITHOUT a full re-render (Monaco content changes
// fire on every keystroke; re-rendering the app each time would thrash the editor).
function updateConnCodeStatus() {
  if (!connMonaco?.editor) return;
  const dirty = connMonaco.editor.getValue() !== connMonaco.savedCode;
  const saveBtn = document.getElementById("conn-code-save");
  const revertBtn = document.getElementById("conn-code-revert");
  const status = document.getElementById("conn-code-status");
  if (saveBtn) saveBtn.disabled = !dirty || state.connBusy;
  if (revertBtn) revertBtn.disabled = !dirty || state.connBusy;
  if (status) {
    status.textContent = state.connBusy ? "Saving…" : (dirty ? "● Unsaved changes" : "Saved");
    status.className = "text-xs ml-auto shrink-0 " + (dirty && !state.connBusy ? "text-amber-600" : "text-stone-400");
  }
}

function connCodeRevert() {
  if (!connMonaco?.editor || state.connBusy) return;
  if (connMonaco.editor.getValue() === connMonaco.savedCode) return;
  if (!confirm("Discard your unsaved changes and revert to the last saved code?")) return;
  connMonaco.editor.setValue(connMonaco.savedCode);
  updateConnCodeStatus();
}

async function connCodeSave() {
  const c = currentConn();
  if (!c || !connMonaco?.editor || state.connBusy) return;
  const code = connMonaco.editor.getValue();
  if (code === connMonaco.savedCode) return;
  if (!confirm(`Save and register this code for connector "${connectorName(c)}"?\n\nIt runs in the connector sandbox on the next Test or Fetch. Any npm packages it imports are installed now. This does not pull data yet.`)) return;
  state.connBusy = true; updateConnCodeStatus();
  try {
    const r = await api(`/api/connectors/${encodeURIComponent(c.id)}/code`, { method: "POST", body: JSON.stringify({ code }) });
    connMonaco.savedCode = code;
    state.connBusy = false;
    await loadConnectors(); // refresh deps/hasCode/history on the Details tab (re-renders; the editor host is re-attached)
    const pkgs = (r.deps || []).length ? `Installed/checked packages: ${(r.deps || []).join(", ")}.` : "No external packages imported.";
    const failed = r.install && r.install.ok === false ? `\n\n⚠ Package install reported a problem:\n${r.install.log || ""}` : "";
    alert(`Saved ${r.bytes} byte(s). ${pkgs}${failed}\n\nTest it (Details → Test, or Fetch rows) to run it.`);
  } catch (e) {
    state.connBusy = false;
    updateConnCodeStatus();
    alert("Save failed: " + (e?.message || e));
  }
}

// The connector currently selected in the Connectors tab (or null).
function currentConn() {
  return (state.connectors?.connectors || []).find((c) => c.id === state.connSel) || null;
}

// Verify — healthcheck the connector's live source. Stamps the result with the
// connector id so connDetail only shows it for the connector it belongs to.
async function connVerify() {
  const c = currentConn();
  if (!c || state.connBusy) return;
  state.connBusy = true; render();
  try {
    const r = await api(`/api/bc/${encodeURIComponent(c.boundedContext)}/adapter/${encodeURIComponent(c.id)}/verify`, { method: "POST", body: "{}" });
    state.connVerify = { id: c.id, ...r };
  } catch (e) {
    state.connVerify = { id: c.id, ok: false, detail: e.message };
  } finally {
    state.connBusy = false; render();
  }
}

// Test — a DRY-RUN pull (limit 5) graded against the model. Nothing is written.
async function connTest() {
  const c = currentConn();
  if (!c || state.connBusy) return;
  state.connBusy = true; render();
  try {
    const r = await api(`/api/bc/${encodeURIComponent(c.boundedContext)}/adapter/${encodeURIComponent(c.id)}/test`, { method: "POST", body: JSON.stringify({ limit: 5 }) });
    state.connTest = { id: c.id, ...r };
  } catch (e) {
    state.connTest = { id: c.id, error: e.message };
  } finally {
    state.connBusy = false; render();
  }
}

async function connSaveDateRoles() {
  const id = state.connSel;
  if (!id || state.connBusy) return;
  const created = document.getElementById("conn-date-created")?.value || null;
  const updated = document.getElementById("conn-date-updated")?.value || null;
  state.connBusy = true; render();
  try {
    await api(`/api/connectors/${encodeURIComponent(id)}/date-roles`, { method: "POST", body: JSON.stringify({ created, updated }) });
    await loadConnectors();
  } catch (e) {
    alert("Couldn't save timestamps: " + e.message);
  } finally {
    state.connBusy = false; render();
  }
}

async function connRepoint() {
  const id = state.connSel;
  if (!id || state.connBusy) return;
  const target = document.getElementById("conn-repoint-target")?.value;
  const cur = (state.connectors?.connectors || []).find((c) => c.id === id);
  const name = cur ? connectorName(cur) : id;
  if (!target || (cur && target === cur.targetEntity)) { alert("Pick a different table to re-point to."); return; }
  if (!confirm(`Re-point connector "${name}" to table "${target}"?\n\nIt will fill "${target}" on the next Fetch. Existing rows in "${cur?.targetEntity}" are left untouched.`)) return;
  state.connBusy = true; render();
  try {
    await api(`/api/connectors/${encodeURIComponent(id)}/repoint`, { method: "POST", body: JSON.stringify({ target }) });
    await loadConnectors();
    alert(`Re-pointed to "${target}".`);
  } catch (e) {
    alert("Re-point failed: " + e.message);
  } finally {
    state.connBusy = false; render();
  }
}

async function connDelete() {
  const id = state.connSel;
  if (!id || state.connBusy) return;
  const cur = (state.connectors?.connectors || []).find((c) => c.id === id);
  const name = cur ? connectorName(cur) : id;
  if (!confirm(`Completely delete connector "${name}"?\n\nThis permanently deletes its code, credentials, ALL ingested rows in "${cur?.targetEntity}", the derived events, and its entire history. The connector is removed. This cannot be undone.`)) return;
  state.connBusy = true; render();
  try {
    const r = await api(`/api/connectors/${encodeURIComponent(id)}/delete`, { method: "POST", body: "{}" });
    state.connSel = null;
    await loadConnectors();
    alert(`Connector "${name}" deleted.\n\nRemoved ${r.deletedRows} row(s) and ${r.deletedEvents} event(s).`);
  } catch (e) {
    alert("Delete failed: " + e.message);
  } finally {
    state.connBusy = false; render();
  }
}

