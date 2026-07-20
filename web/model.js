// Model page (#model) — version history, reload/restore, source link, and the
// registry banner/toast. Extracted from app.js.
import { state } from "./state.js";
import { escapeHtml } from "./format.js";
import { api, ensureMe, showOverlay, hideOverlay, onHashChange, render, selectedWorkflowId } from "./app.js";

// ---------------------------------------------------------------------------
// Model sync / version history
// ---------------------------------------------------------------------------

export async function loadRegistryStatus() {
  try {
    const s = await api("/sim/registry-status");
    state.registryError = s.ok ? null : s.error;
  } catch {
    // A failure here shouldn't blank the banner state; leave it as-is.
  }
}

// Set-this-workflow's-model control. Points the active workflow at a Qlerify model
// (link, or uploaded/pasted workflow.json) and rebuilds this workflow's data.
// Set-or-replace form, inlined on the Model page (#model) when opened.
export function modelReplaceInline() {
  if (!state.projModelOpen) return "";
  const err = state.projModelErr ? `<div class="text-sm text-rose-600 mb-3">${escapeHtml(state.projModelErr)}</div>` : "";
  return `
    <div class="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
      <div class="text-sm font-semibold text-stone-800">Replace this workflow's model</div>
      <div class="text-xs text-stone-500 mt-0.5 mb-3">Point the workflow at a Qlerify model. It replaces <b>this workflow's</b> model and rebuilds <b>this workflow's</b> data.</div>
      ${err}
      <label class="block text-sm font-medium text-stone-700 mb-1">Qlerify model link</label>
      <input id="proj-model-url" type="url" value="${escapeHtml(state.projModelUrl || "")}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm bg-white" placeholder="https://app.qlerify.com/workflow/&lt;projectId&gt;/&lt;workflowId&gt;" />
      <div class="text-xs text-stone-500 mt-1">Paste the workflow URL from the Qlerify modeller — we'll pull the latest model.</div>
      <details class="mt-3">
        <summary class="text-sm text-stone-600 cursor-pointer select-none hover:text-stone-900">Advanced — upload or paste a workflow.json instead</summary>
        <div class="mt-3">
          <div class="mb-2 flex items-center gap-2">
            <input id="proj-model-file" type="file" accept=".json,application/json" class="text-sm" />
            <span class="text-xs text-stone-400">— or paste below —</span>
          </div>
          <textarea id="proj-model-text" class="w-full h-40 rounded-md border border-stone-300 p-2 text-xs mono bg-white" placeholder='{ "boundedContext": "...", "domainEvents": { ... } }'>${escapeHtml(state.projModelText || "")}</textarea>
        </div>
      </details>
      <div class="mt-3 flex items-center justify-end gap-2">
        <button id="proj-model-cancel" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
        <button id="proj-model-apply" ${state.projModelBusy ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">${state.projModelBusy ? "Applying…" : "Apply to workflow"}</button>
      </div>
    </div>`;
}

export function bindWorkflowModel() {
  document.getElementById("proj-model-cancel")?.addEventListener("click", () => { state.projModelOpen = false; render(); });
  document.getElementById("proj-model-url")?.addEventListener("input", (e) => { state.projModelUrl = e.target.value; });
  // Don't re-render on file load (it would collapse the <details>); fill the textarea directly.
  document.getElementById("proj-model-file")?.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      state.projModelText = String(r.result || "");
      const ta = document.getElementById("proj-model-text");
      if (ta) ta.value = state.projModelText;
    };
    r.readAsText(f);
  });
  document.getElementById("proj-model-text")?.addEventListener("input", (e) => { state.projModelText = e.target.value; });
  document.getElementById("proj-model-apply")?.addEventListener("click", async () => {
    const url = ((document.getElementById("proj-model-url") || {}).value || state.projModelUrl || "").trim();
    const text = ((document.getElementById("proj-model-text") || {}).value || state.projModelText || "").trim();
    let payload;
    if (url) {
      payload = { sourceUrl: url }; // primary: pull from the Qlerify modeller
    } else if (text) {
      try { JSON.parse(text); } catch (_e) { state.projModelErr = "The pasted/uploaded model isn't valid JSON."; render(); return; }
      payload = { workflow: text }; // secondary: uploaded / pasted workflow.json
    } else {
      state.projModelErr = "Paste a Qlerify model link (or upload/paste a workflow.json under Advanced)."; render(); return;
    }
    state.projModelBusy = true; state.projModelErr = null; render();
    showOverlay("Loading model…");
    try {
      const res = await api("/v1/workflow/model", { method: "PUT", body: JSON.stringify(payload) });
      state.projModelOpen = false; state.projModelBusy = false; state.projModelText = ""; state.projModelUrl = "";
      state.modelMsg = { ok: true, text: "Workflow model updated — rebuilt this workflow." + rebuildSummaryText(res && res.rebuild) };
      await ensureMe();
      await onHashChange();
      setTimeout(() => { state.modelMsg = null; render(); }, 4000);
    } catch (e) {
      state.projModelBusy = false;
      state.projModelErr = (e && e.message) ? e.message : "Failed to set the model.";
      render();
    } finally {
      hideOverlay();
    }
  });
}

// ---------------------------------------------------------------------------
// Model page (#model) — version history, reload, restore, and the source link,
// all on one page (ported from the pre-multi-tenant build, rewired to the
// per-workflow /v1/workflow/model/* endpoints).
// ---------------------------------------------------------------------------

// Compact display form of a workflow URL — keep the tail recognizable (so two
// workflows are still distinguishable) while hiding the long opaque ids.
export function shortWorkflowUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    const shortId = last.length > 12 ? `${last.slice(0, 8)}…${last.slice(-4)}` : last;
    return `${u.host}/…/${shortId}`;
  } catch {
    return url.length > 36 ? `${url.slice(0, 18)}…${url.slice(-12)}` : url;
  }
}

// Short, human-readable form of a version's ISO timestamp, e.g. "Jun 14, 13:45".
export function formatVersionDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Sidebar listing every stored version (newest first), each with a Restore
// action; the current version is highlighted instead.
export function modelVersionSidebar() {
  const s = state.modelStatus;
  if (!s) return `<aside class="w-56 shrink-0 border-r border-stone-200 bg-white overflow-auto p-3 text-[11px] text-stone-400">Loading versions…</aside>`;
  const versions = s.versions || [];
  if (versions.length === 0) {
    return `<aside class="w-56 shrink-0 border-r border-stone-200 bg-white overflow-auto p-3 text-[11px] text-stone-400 leading-relaxed">No saved versions yet.</aside>`;
  }
  const rows = versions
    .map((v, i) => {
      const isCurrent = i === s.current;
      const sourceCls = v.source === "initial"
        ? "bg-stone-100 text-stone-500"
        : v.source === "restore"
          ? "bg-violet-100 text-violet-700"
          : "bg-sky-100 text-sky-700";
      const events = v.summary ? (v.summary.events ?? 0) : 0;
      let srcLine;
      if (v.sourceUrl) {
        const label = v.sourceName || shortWorkflowUrl(v.sourceUrl);
        const monoCls = v.sourceName ? "" : "mono ";
        const tip = v.sourceName ? `${v.sourceName} — ${v.sourceUrl}` : v.sourceUrl;
        srcLine = `<a href="${escapeHtml(v.sourceUrl)}" target="_blank" rel="noopener" class="block text-[10px] ${monoCls}text-sky-700 hover:text-sky-900 truncate mt-0.5" title="Fetched from ${escapeHtml(tip)}">${escapeHtml(label)} ↗</a>`;
      } else {
        srcLine = `<div class="text-[10px] text-stone-300 italic mt-0.5">uploaded / pasted</div>`;
      }
      return `
        <li class="px-2.5 py-2 rounded-md border ${isCurrent ? "border-amber-300 bg-amber-50" : "border-transparent hover:bg-stone-50"} flex items-start gap-2">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-[12px] font-semibold tabular-nums">v${i + 1}</span>
              <span class="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded ${sourceCls}">${escapeHtml(v.source)}</span>
            </div>
            <div class="text-[10px] text-stone-500 tabular-nums mt-0.5">${escapeHtml(formatVersionDate(v.savedAt))}</div>
            <div class="text-[10px] text-stone-400 tabular-nums">${events} events</div>
            ${srcLine}
          </div>
          ${isCurrent
            ? `<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 shrink-0 mt-0.5">current</span>`
            : `<button data-restore-id="${escapeHtml(v.id)}" ${state.modelBusy ? "disabled" : ""} class="model-restore-btn text-[10px] px-2 py-1 rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 shrink-0 mt-0.5" title="Restore this version">Restore</button>`}
        </li>`;
    })
    .reverse()
    .join("");
  return `
    <aside class="w-56 shrink-0 border-r border-stone-200 bg-white overflow-auto">
      <div class="px-3 pt-3 pb-1 text-[10px] uppercase tracking-widest text-stone-500 font-semibold sticky top-0 bg-white">Versions</div>
      <ul class="px-2 pb-3 flex flex-col gap-1">${rows}</ul>
    </aside>`;
}

// Model page (#model) — version history, reload, replace, and read-only JSON.
export function modelView() {
  const s = state.modelStatus;
  const total = s ? s.total : 0;
  const current = s ? s.current : -1;
  const events = s && s.currentVersion && s.currentVersion.summary ? (s.currentVersion.summary.events ?? 0) : 0;
  const versionLabel = total > 0 ? `v${current + 1} of ${total} · ${events} domain events` : "Not versioned yet";
  const reloadUrl = s ? s.sourceUrl : null;
  const wfId = selectedWorkflowId();
  const wfName = (state.me?.workflows || []).find((w) => w.id === wfId)?.name || "Workflow";
  const content = state.modelContent;
  const sizeKb = content ? Math.round(content.length / 1024) : 0;
  const assistantBtn = `<button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>`;
  const body = content == null
    ? `<div class="flex-1 flex items-center justify-center p-8 text-center">
        <div>
          <div class="text-3xl mb-2">🧩</div>
          <div class="text-sm font-medium text-stone-700">${state.modelStatus == null ? "Loading model…" : "This workflow has no model yet"}</div>
          ${state.modelNoContent ? `<div class="text-xs text-stone-500 mt-1 max-w-sm">Point it at a Qlerify model using <b>Replace</b> above.</div>` : ""}
        </div>
      </div>`
    : `<pre class="mono text-[12px] leading-relaxed whitespace-pre p-4 overflow-auto flex-1">${escapeHtml(content)}</pre>`;
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4">
        <div class="flex items-center gap-4 flex-wrap">
          <div class="flex-1 min-w-0">
            <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Qlerify model</div>
            <div class="text-stone-900 text-xl font-semibold leading-tight truncate">${escapeHtml(wfName)}</div>
            <div class="text-xs text-stone-500 mt-0.5 tabular-nums">${escapeHtml(versionLabel)}${content ? ` · ${sizeKb} KB` : ""}</div>
          </div>
          <button id="btn-model-reload" ${state.modelBusy || !reloadUrl ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium" title="${reloadUrl ? "Re-pull the latest model from the source link, then rebuild this workflow" : "No source link — this model was uploaded or pasted. Use Replace to re-point it."}">${state.modelBusy ? "⏳ Working…" : "⤓ Reload"}</button>
          <button id="btn-model-replace" ${state.modelBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium" title="Replace this workflow's model — change the link, or upload/paste a new workflow.json">${state.projModelOpen ? "✕ Close replace" : "✎ Replace"}</button>
          ${assistantBtn}
        </div>
        <div class="mt-3 flex items-center gap-2 flex-wrap text-sm">
          <span class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold shrink-0">Source</span>
          ${reloadUrl
            ? `<a href="${escapeHtml(reloadUrl)}" target="_blank" rel="noopener" class="min-w-0 max-w-md text-[12px] mono text-sky-700 hover:text-sky-900 underline decoration-dotted truncate" title="${escapeHtml(reloadUrl)}">${escapeHtml(shortWorkflowUrl(reloadUrl))} ↗</a>`
            : `<span class="text-[12px] text-stone-400 italic">uploaded / pasted — no link</span>`}
        </div>
        ${modelReplaceInline()}
      </div>
    </header>
    <main class="flex-1 flex min-h-0 overflow-hidden">
      ${modelVersionSidebar()}
      <div class="flex-1 overflow-auto bg-stone-50 flex flex-col min-w-0">${body}</div>
    </main>`;
}

export async function loadModel() {
  state.modelStatus = null;
  state.modelContent = null;
  state.modelNoContent = false;
  render();
  const [status, content] = await Promise.allSettled([
    api("/v1/workflow/model/status"),
    api("/v1/workflow/model/content"),
  ]);
  if (status.status === "fulfilled") state.modelStatus = status.value;
  else state.modelStatus = { versions: [], current: -1, total: 0, currentVersion: null, sourceUrl: null };
  if (content.status === "fulfilled") {
    state.modelContent = content.value.content || "";
  } else {
    state.modelContent = null;
    state.modelNoContent = true;
    if (!state.projModelOpen) state.projModelOpen = true;
  }
  render();
}

// Pull the version list + current model body for the Model page.
export async function refreshModelPage() {
  const [status, content] = await Promise.allSettled([
    api("/v1/workflow/model/status"),
    api("/v1/workflow/model/content"),
  ]);
  if (status.status === "fulfilled") state.modelStatus = status.value;
  if (content.status === "fulfilled") {
    state.modelContent = content.value.content || "";
    state.modelNoContent = false;
    state.projModelOpen = false;
  }
  render();
}

// One-line tail describing the post-rebuild re-ingest + derive (the `rebuild`
// field every /v1/workflow/model* response now carries). Empty when the workflow
// has no connectors to pull from — the rebuilt tables just start empty.
export function rebuildSummaryText(rebuild) {
  if (!rebuild || !rebuild.connectors) return "";
  const ev = rebuild.derived ? rebuild.derived.events : 0;
  const failed = (rebuild.failures || []).length;
  return ` Re-ingested ${rebuild.inserted} row(s) from ${rebuild.connectors} connector(s), derived ${ev} event(s)${failed ? ` — ${failed} connector(s) failed to pull (re-pull from the explorer)` : ""}.`;
}

// Re-pull the latest model from the current version's stored link, then rebuild
// this workflow. Disabled in the UI when there is no link to pull from.
export async function reloadWorkflowModel() {
  if (state.modelBusy) return;
  state.modelBusy = true; render();
  showOverlay("Reloading model…");
  try {
    const res = await api("/v1/workflow/model/reload", { method: "POST", body: "{}" });
    state.modelMsg = { ok: true, text: "Reloaded the latest model from the source link — rebuilt this workflow." + rebuildSummaryText(res && res.rebuild) };
    await refreshModelPage();
    await ensureMe();
    await onHashChange();
  } catch (e) {
    state.modelMsg = { ok: false, text: (e && e.message) ? e.message : "Reload failed." };
  } finally {
    state.modelBusy = false; hideOverlay();
    // Auto-dismiss the success toast; leave an error banner up so a config
    // message (e.g. "add a Qlerify key in Organisation admin") stays readable
    // and actionable until the next action replaces it.
    if (state.modelMsg && state.modelMsg.ok) setTimeout(() => { state.modelMsg = null; render(); }, 3000);
    else render();
  }
}

// Restore a stored version: re-applies it as a NEW current version + rebuilds.
export async function restoreWorkflowVersion(versionId) {
  if (state.modelBusy || !versionId) return;
  state.modelBusy = true; render();
  showOverlay("Restoring model…");
  try {
    const res = await api("/v1/workflow/model/restore", { method: "POST", body: JSON.stringify({ versionId }) });
    state.modelMsg = { ok: true, text: "Restored that version — rebuilt this workflow." + rebuildSummaryText(res && res.rebuild) };
    await refreshModelPage();
    await ensureMe();
    await onHashChange();
  } catch (e) {
    state.modelMsg = { ok: false, text: (e && e.message) ? e.message : "Restore failed." };
  } finally {
    state.modelBusy = false; hideOverlay();
    setTimeout(() => { state.modelMsg = null; render(); }, 3000);
  }
}

export function bindModelPage() {
  document.getElementById("btn-model-reload")?.addEventListener("click", reloadWorkflowModel);
  document.getElementById("btn-model-replace")?.addEventListener("click", () => {
    state.projModelOpen = !state.projModelOpen;
    state.projModelErr = null;
    render();
  });
  document.querySelectorAll(".model-restore-btn").forEach((btn) => btn.addEventListener("click", () => restoreWorkflowVersion(btn.getAttribute("data-restore-id"))));
  bindWorkflowModel();
}

// Persistent banner shown when the loaded Qlerify model doesn't match the
// simulator's event registry (EVENTS is empty server-side). Rendered in flow at
// the very top so it pushes the view down rather than crashing the app.
export function registryBanner() {
  if (!state.registryError) return "";
  return `
    <div class="bg-rose-600 text-white px-6 py-3 text-sm shadow">
      <div class="font-semibold">⚠ This workflow's model couldn't be loaded</div>
      <div class="mt-0.5 opacity-90">${escapeHtml(state.registryError)}</div>
      <div class="mt-1 text-xs opacity-80">The event registry couldn't be built from the current model. Open the <b>Model</b> tab and replace it with a valid Qlerify model.</div>
    </div>
  `;
}

export function modelToast() {
  if (!state.modelMsg) return "";
  const tone = state.modelMsg.ok ? "bg-emerald-600" : "bg-rose-600";
  return `
    <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 ${tone} text-white text-sm px-4 py-2 rounded-lg shadow-lg max-w-lg">
      ${escapeHtml(state.modelMsg.text)}
    </div>
  `;
}

// Global blocking loading overlay — a dim scrim + a centered spinner card with a
// contextual label, shown while a long, server-synchronous op runs (model
// load/rebuild, workflow/org switch, explorer data load/delete/refresh). Driven
// purely by state.overlay and emitted from wrap(), so it reappears on every
// render and the scrim blocks all clicks until the op finishes. Mirrors the
// modelToast() pattern (return "" when inactive). z-[60] sits above dialogs
// (z-50) and the toast (z-40).
