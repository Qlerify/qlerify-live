// Model-driven workflow demo UI — vanilla JS + Tailwind.
// Two views:
//   1. Dashboard:  table of cases with status + progress, "+ New case" button.
//   2. Detail:     per-case timeline + 7 BC panels, step-forward controls.
// Navigation is hash-based: "#" → dashboard, "#case/<id>" → detail.

import { escapeHtml, prettyEntity, renderTextContent } from "./format.js";
import { state } from "./state.js";
import { PROV_STYLE, EVIDENCE_KIND, provChip, evidenceChip, provHatch, provModeForBC } from "./chips.js";
import { loadChatInfo, chatScope, syncChatScope, resetChatState, activateConnectorChat, deactivateConnectorChat, chatPanel, bindChat } from "./chat.js";
import { loadOrg, orgView, bindOrg } from "./org.js";
import { NOTE_BADGE, expState, connectorName, explorerView, bindExplorer, loadExplorer } from "./explorer.js";
import { loadRegistryStatus, modelView, loadModel, bindModelPage, registryBanner, modelToast, formatVersionDate } from "./model.js";
import { loadDashboard, loadFlow, loadFlowRows, loadOverview, loadMeta, genericColumns, attrText, dashboardView, bindDashboard } from "./dashboard.js";
import { loadDetail, detailView, bindDetail, mergedFlowView, flowRowsView, bindFlowRows } from "./detail.js";

const API = "";
const role = "Automation";
const root = document.getElementById("app");

export const STATUS_TONE = {
  NEW: "bg-stone-200 text-stone-700",
  PLANNED: "bg-sky-100 text-sky-800",
  DELIVERED: "bg-emerald-100 text-emerald-800",
  DRAFT: "bg-stone-200 text-stone-700",
  LOCKED: "bg-amber-100 text-amber-800 ring-1 ring-amber-300",
  SUPERSEDED: "bg-stone-200 text-stone-500 line-through",
  RELEASED: "bg-sky-100 text-sky-800",
  IN_PROGRESS: "bg-indigo-100 text-indigo-800",
  RTD: "bg-emerald-100 text-emerald-800",
  SHIPPED: "bg-emerald-100 text-emerald-800",
  ORDERED: "bg-sky-100 text-sky-800",
  CONFIRMED: "bg-indigo-100 text-indigo-800",
  RECEIVED: "bg-emerald-100 text-emerald-800",
  OPEN: "bg-rose-100 text-rose-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-stone-300 text-stone-700",
  AT_RISK: "bg-rose-100 text-rose-800 ring-1 ring-rose-300",
  KIT_READY: "bg-emerald-100 text-emerald-800",
  BOOKED: "bg-sky-100 text-sky-800",
  RUNNING: "bg-indigo-100 text-indigo-800",
  DONE: "bg-emerald-100 text-emerald-800",
  CREATED: "bg-stone-200 text-stone-700",
  CLOSED: "bg-emerald-100 text-emerald-800",
  PASS: "bg-emerald-100 text-emerald-800",
  FAIL: "bg-rose-100 text-rose-800",
  PREPARING: "bg-stone-200 text-stone-700",
  READY: "bg-sky-100 text-sky-800",
  IN_TRANSIT: "bg-indigo-100 text-indigo-800",
  BUILT: "bg-stone-200 text-stone-700",
  PACKED: "bg-sky-100 text-sky-800",
  PICKED: "bg-sky-100 text-sky-800",
  LOST: "bg-rose-100 text-rose-800",
  DS1: "bg-sky-100 text-sky-800",
  DS2_PROD: "bg-emerald-100 text-emerald-800",
};

export const PHASE_TONE = {
  1: "border-stone-300",
  2: "border-amber-300",
  3: "border-rose-300",
  4: "border-sky-400",
  5: "border-emerald-400",
};

// Provenance/evidence chips + the mutable UI `state` object now live in their
// own modules (./chips.js, ./state.js), imported at top.

// --- Tenant auth/session (localStorage-backed) ------------------------------
// Every request must authenticate: with no token the server replies 401 and the
// api() wrapper redirects to the login screen (there is no header-less demo). A
// token (from /v1/auth/login) is sent as a bearer; the chosen org is sent as
// X-Org-Id (which only SELECTS among the identity's orgs — the server derives the
// canonical org_id).
export const AUTH = {
  token: () => localStorage.getItem("ql.token") || "",
  org: () => localStorage.getItem("ql.org") || "",
  workflow: () => localStorage.getItem("ql.workflow") || "",
  setSession: (token) => localStorage.setItem("ql.token", token || ""),
  // Switching org invalidates the selected workflow — clear it so the new org
  // resolves its own default workflow (or the empty-org state) until one is picked.
  // Org/workflow switches also swap the chat threads (syncChatScope) — every
  // switch path funnels through these two setters, so hooking here covers them all.
  setOrg: (orgId) => { if (orgId) localStorage.setItem("ql.org", orgId); else localStorage.removeItem("ql.org"); localStorage.removeItem("ql.workflow"); syncChatScope(); },
  setWorkflow: (id) => { if (id) localStorage.setItem("ql.workflow", id); else localStorage.removeItem("ql.workflow"); syncChatScope(); },
  clear: () => { localStorage.removeItem("ql.token"); localStorage.removeItem("ql.org"); localStorage.removeItem("ql.workflow"); resetChatState(); },
};
// Attribute the boot-time (empty) threads to the boot scope, so the first real
// switch has an old scope to stash under. chatScope is hoisted.
state.chatScope = chatScope();

export async function api(path, opts = {}) {
  const headers = { "x-role": role, ...(opts.headers || {}) };
  if (opts.body != null) headers["Content-Type"] = "application/json";
  const token = AUTH.token();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const org = AUTH.org();
  if (org) headers["X-Org-Id"] = org;
  const workflow = AUTH.workflow();
  if (workflow) headers["X-Workflow-Id"] = workflow;
  const res = await fetch(API + path, { cache: "no-store", ...opts, headers });
  if (res.status === 401 && !path.startsWith("/v1/auth/")) {
    AUTH.clear();
    if (location.hash !== "#login") navigate("#login");
    throw new Error(`401 ${path}: session expired — please sign in`);
  }
  if (!res.ok) {
    const text = await res.text();
    // Prefer the backend's human-readable {message}: it's already a clean sentence
    // (e.g. the friendly LLM-key error). Fall back to the raw "status path: body"
    // form only when there's no JSON message, so unexpected errors stay debuggable.
    let msg = `${res.status} ${path}: ${text}`;
    try { const j = JSON.parse(text); if (j && typeof j.message === "string" && j.message) msg = j.message; } catch { /* not JSON */ }
    const err = new Error(msg);
    err.status = res.status; err.path = path;
    throw err;
  }
  return res.json();
}


function overlayView() {
  const o = state.overlay;
  if (!o || o.count <= 0 || !o.active) return "";
  return `
    <div class="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center" role="status" aria-live="polite" aria-busy="true">
      <div class="bg-white rounded-xl shadow-xl px-6 py-5 flex items-center gap-3">
        <div class="w-6 h-6 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin"></div>
        <div class="text-sm text-stone-700">${escapeHtml(o.label || "Working…")}</div>
      </div>
    </div>`;
}

// Show the loading overlay with `label`. Ref-counted: the first show (0→1) arms a
// short delay so a sub-150ms op never flashes a scrim; nested shows just bump the
// count and update the label.
export function showOverlay(label) {
  const o = state.overlay;
  o.label = label || "Working…";
  o.count += 1;
  if (o.count === 1 && !o.active && o.timer === null) {
    o.timer = setTimeout(() => { o.timer = null; o.active = true; render(); }, 150);
  }
  render();
}

// Hide one level of the overlay. On the final hide (→0) cancel a still-pending
// delay (so a quick op never shows) and clear the active scrim.
export function hideOverlay() {
  const o = state.overlay;
  o.count = Math.max(0, o.count - 1);
  if (o.count === 0) {
    if (o.timer !== null) { clearTimeout(o.timer); o.timer = null; }
    o.active = false;
    o.label = "";
  }
  render();
}

// Convenience wrapper: show the overlay for the duration of `fn`, clearing it
// even if `fn` throws. The primary API for call sites; existing per-button busy
// flags stay (they drive disabled state + button labels — the overlay is additive).
async function withOverlay(label, fn) {
  showOverlay(label);
  try { return await fn(); }
  finally { hideOverlay(); }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function parseHash() {
  const h = location.hash || "";
  let m;
  if (h.startsWith("#login")) return { view: "login" };
  if (h.startsWith("#admin")) return { view: "admin" };
  if (h.startsWith("#org")) return { view: "org" };
  if (h.startsWith("#model")) return { view: "model" };
  if (h.startsWith("#flow")) return { view: "flow" };
  if (h.startsWith("#rows")) return { view: "rows" };
  if (h.startsWith("#list")) return { view: "dashboard" };
  if ((m = h.match(/^#connectors(?:\/(.+))?$/))) return { view: "connectors", connSel: m[1] ? decodeURIComponent(m[1]) : null };
  if ((m = h.match(/^#bcs(?:\/([^/]+)(?:\/(.+))?)?$/))) return { view: "bcs", expSys: m[1] ? decodeURIComponent(m[1]) : null, expEntity: m[2] ? decodeURIComponent(m[2]) : null };
  if ((m = h.match(/^#case\/([\w-]+)/))) return { view: "detail", caseId: m[1] };
  // Bare "#" (the Overview home) is a SMART default: the merged Workflow flow
  // when this workflow has cases, else the case List. Resolved in loadOverview().
  return { view: "overview" };
}

export function navigate(hash) {
  // The browser stores the bare/Overview hash as "" but callers pass "#", so a
  // raw === miss the equality and take the else branch — where assigning
  // location.hash = "#" gets collapsed back to "" by the browser, fires no
  // hashchange event, and leaves onHashChange()/ensureMe() un-run (state stays
  // stale, e.g. a freshly created org missing from the switcher). Normalise both
  // sides so the "same view" case reliably triggers the manual reload below.
  const norm = (h) => (h === "#" ? "" : h);
  if (norm(location.hash) === norm(hash)) {
    // hash unchanged — manually trigger reload
    onHashChange();
  } else {
    location.hash = hash;
  }
}


const WORKFLOW_SCOPED_VIEWS = new Set(["overview", "dashboard", "detail", "flow", "rows", "model", "bcs", "connectors"]);

async function ensureWorkflowSelected() {
  if (AUTH.workflow()) return;
  await ensureMe();
  const id = state.me?.workflowId;
  if (id) AUTH.setWorkflow(id);
}

export async function onHashChange() {
  const r = parseHash();
  state.view = r.view;
  state.caseId = r.caseId ?? null;
  if (r.connSel) state.connSel = r.connSel; // deep-link: #connectors/<id> preselects it
  state.issuedCredential = null; // a one-time temp password never survives navigation
  // Leaving the Systems explorer hands the chat panel back to the Process
  // advisor (re-entering re-activates the table's connector thread).
  if (r.view !== "bcs") deactivateConnectorChat();

  if (state.dashboardTimer) { clearInterval(state.dashboardTimer); state.dashboardTimer = null; }

  if (r.view === "login") { render(); return; }

  // The portfolio (#org) is org-wide regardless of the active workflow, so we
  // deliberately DON'T deselect here: keeping the selection means a focused
  // workflow simply narrows the portfolio (the "Focused: …" chip) and Back
  // returns to that workflow. Defocusing to the full portfolio is explicit
  // (the logo, the switcher's "All workflows", or the chip's "View all").
  await ensureMe(); // load the tenant context for the top bar (best-effort)
  // If a 401 during ensureMe() cleared the session and redirected us, render the
  // login screen now instead of flashing a frame of header-less content.
  if (location.hash === "#login") { state.view = "login"; render(); return; }

  // A member signed in with an admin-issued temporary password is GATED here:
  // they must set their own password before any org/workflow data loads. Survives
  // a reload because whoami carries mustChangePassword (not just the login reply).
  if (state.me && state.me.mustChangePassword) {
    state.cpForced = true;
    state.cpReturn = "#org";
    state.view = "change-password";
    render();
    return;
  }

  // Authenticated but not a member of any organisation yet (a fresh superadmin, or
  // a user whose last membership was removed) → the create-first-organisation
  // screen. Distinct from an org that merely has zero workflows (empty-org below).
  if (state.me && !state.me.organizationId) { state.view = "no-org"; render(); return; }

  // Empty org (a fresh org, or its last workflow was deleted): the data plane fails
  // closed, so don't fetch it — show the "create your first workflow" state. Admin
  // stays reachable so the user can manage the org and create a workflow there too.
  const emptyOrg = state.me && (state.me.workflows || []).length === 0;
  if (emptyOrg && r.view !== "admin") {
    state.view = "empty-org";
    render();
    return;
  }

  if (WORKFLOW_SCOPED_VIEWS.has(r.view)) {
    await ensureWorkflowSelected();
    await ensureMe();
  }

  // A workflow that exists but has no model yet → the data plane throws
  // MODEL_NOT_LOADED. Catch it and show the "set this workflow's model" prompt
  // instead of a broken view.
  try {
    if (r.view === "detail") {
      await loadDetail();
    } else if (r.view === "admin") {
      await loadAdmin();
    } else if (r.view === "bcs") {
      // deep-link: #bcs/<system>/<table> opens the explorer on that table.
      if (r.expSys) { const e = expState(); e.system = r.expSys; e.pendingEntity = r.expEntity || null; }
      await loadExplorer();
    } else if (r.view === "connectors") {
      await loadConnectors();
    } else if (r.view === "model") {
      await loadModel();
    } else if (r.view === "flow") {
      await loadFlow();
      // Poll every 5s so the per-event counters tick up live as cases run.
      state.dashboardTimer = setInterval(() => {
        if (state.view === "flow" && !state.busy) loadFlow().catch(() => {});
      }, 5000);
    } else if (r.view === "rows") {
      await loadFlowRows();
      // Poll every 5s so rows appear / fill in live as cases run.
      state.dashboardTimer = setInterval(() => {
        if (state.view === "rows" && !state.busy) loadFlowRows().catch(() => {});
      }, 5000);
    } else if (r.view === "overview") {
      await loadOverview();
    } else if (r.view === "org") {
      await loadOrg();
      // Poll every 5s so the portfolio reads as a live control tower.
      state.dashboardTimer = setInterval(() => {
        if (state.view === "org" && !state.orgBusy) loadOrg().catch(() => {});
      }, 5000);
    } else {
      await loadDashboard();
      // Poll every 5s so "last activity" pills age in front of the audience.
      state.dashboardTimer = setInterval(() => {
        if (state.view === "dashboard" && !state.busy) loadDashboard().catch(() => {});
      }, 5000);
    }
  } catch (e) {
    if (isNoModelErr(e)) {
      state.projModelOpen = true;
      if (state.view !== "model") { navigate("#model"); return; }
      await loadModel();
      return;
    }
    throw e;
  }
}

// The API helper throws Error(`<status> <path>: <body>`); the body carries the
// server's error code. Detect the "workflow has no model yet" state so the UI can
// prompt for one rather than surfacing a raw error.
function isNoModelErr(e) {
  return !!e && typeof e.message === "string" && /MODEL_NOT_LOADED/.test(e.message);
}

// ---------------------------------------------------------------------------
// Render dispatcher
// ---------------------------------------------------------------------------

// Every render() rebuilds the view via root.innerHTML, which destroys whatever
// element the user was typing in. The 5s background polls (loadFlow/loadDashboard/
// loadOrg/...) call render() too, so an open input loses focus and its caret every
// few seconds. Snapshot the focused editable element (by id) + its selection before
// the rebuild and restore it afterward so typing is never interrupted.
function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.id) return null;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !el.isContentEditable) return null;
  const snap = { id: el.id };
  try {
    if (tag === "INPUT" || tag === "TEXTAREA") {
      snap.start = el.selectionStart;
      snap.end = el.selectionEnd;
    }
  } catch { /* some input types disallow selection access */ }
  return snap;
}

function restoreFocus(snap) {
  if (!snap) return;
  const el = document.getElementById(snap.id);
  if (!el || el === document.activeElement) return;
  try {
    el.focus({ preventScroll: true });
    if (snap.start != null && el.setSelectionRange) el.setSelectionRange(snap.start, snap.end);
  } catch { /* element may no longer be focusable */ }
}

export function render() {
  const focusSnap = captureFocus();
  try {
    renderView();
  } finally {
    restoreFocus(focusSnap);
  }
}

// Put the freshly rebuilt timeline back where the user had scrolled it (both
// axes — the by-case view scrolls vertically too). Returns the scroller so
// callers can run follow-up positioning on it.
function restoreTimelineScroll(left, top) {
  const scroller = document.getElementById("timeline-scroll");
  if (scroller) {
    scroller.scrollLeft = left;
    scroller.scrollTop = top;
  }
  return scroller;
}

function renderView() {
  // Tear down the connector code editor when leaving its view, so its DOM/listeners
  // don't leak (it's rebuilt on demand when the Code tab is next opened).
  if (state.view !== "connectors") disposeConnMonaco();
  // The detail/flow/rows timelines all live in #timeline-scroll and are rebuilt
  // wholesale via innerHTML (including on the 5s live polls) — snapshot the
  // scroll position so those branches can put the user back where they were.
  const prevScroller = document.getElementById("timeline-scroll");
  const prevScroll = prevScroller?.scrollLeft ?? 0;
  const prevScrollTop = prevScroller?.scrollTop ?? 0;
  const mainShiftCls = state.chatOpen ? "mr-[420px]" : "";
  // Every main view is wrapped with the tenant shell (scope bar + workflow
  // section tabs) so the whole app reads as a multi-tenant console.
  const shell = () => `${tenantBar()}${sectionBar()}`;
  const wrap = (inner) => `<div class="${mainShiftCls} flex flex-col min-h-screen transition-[margin-right] duration-200">${shell()}${registryBanner()}${inner}</div>${chatPanel()}${modelToast()}${newOrgDialog()}${newWfDialog()}${overlayView()}`;

  if (state.view === "login") {
    root.innerHTML = loginView();
    bindLogin();
    return;
  }

  if (state.view === "change-password") {
    root.innerHTML = changePasswordView();
    bindChangePassword();
    return;
  }

  if (state.view === "no-org") {
    root.innerHTML = noOrgView();
    bindNoOrg();
    return;
  }

  if (state.view === "detail") {
    root.innerHTML = wrap(detailView());
    bindTenantBar();
    bindDetail();
    bindChat();
    const scroller = restoreTimelineScroll(prevScroll, prevScrollTop);
    // Keep the focused card in view: the selected one while scrubbing (so arrow
    // navigation follows it), otherwise the latest fired step.
    const focusIdx = state.selectedStep != null ? state.selectedStep : state.currentIndex - 1;
    if (focusIdx >= 0 && scroller) {
      const node = scroller.querySelector(`[data-step="${focusIdx}"]`);
      if (node) {
        const nodeBox = node.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const offLeft  = nodeBox.left  < scrollerBox.left;
        const offRight = nodeBox.right > scrollerBox.right;
        if (offLeft || offRight) {
          node.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
        }
      }
    }
  } else if (state.view === "admin") {
    root.innerHTML = wrap(adminView());
    bindTenantBar();
    bindAdmin();
    bindChat();  } else if (state.view === "empty-org") {
    root.innerHTML = wrap(emptyOrgView());
    bindTenantBar();
    bindEmptyOrg();
    bindChat();
  } else if (state.view === "flow") {
    root.innerHTML = wrap(mergedFlowView());
    bindTenantBar();
    bindChat();
    restoreTimelineScroll(prevScroll, prevScrollTop);
  } else if (state.view === "rows") {
    root.innerHTML = wrap(flowRowsView());
    bindTenantBar();
    bindChat();
    bindFlowRows();
    restoreTimelineScroll(prevScroll, prevScrollTop);
  } else if (state.view === "model") {
    root.innerHTML = wrap(modelView());
    bindTenantBar();
    bindModelPage();
    bindChat();
  } else if (state.view === "bcs") {
    root.innerHTML = wrap(explorerView());
    bindTenantBar();
    bindExplorer();
    bindChat();  } else if (state.view === "connectors") {
    root.innerHTML = wrap(connectorsView());
    bindTenantBar();
    bindConnectors();
    bindChat();
  } else if (state.view === "org") {
    root.innerHTML = wrap(orgView());
    bindTenantBar();
    bindOrg();
    bindChat();
  } else {
    root.innerHTML = wrap(dashboardView());
    bindTenantBar();
    bindDashboard();
    bindChat();  }

}

// ===========================================================================
// Tenant shell — login, who-am-I, org switcher, breadcrumb, Org Admin page
// ===========================================================================

/** Best-effort load of the current tenant context for the top bar. Never throws:
 * with no valid session, whoami 401s and api() redirects to the login screen. */
export async function ensureMe() {
  try {
    state.me = await api("/v1/whoami");
    state.orgs = state.me.organizations || [];
    return;
  } catch (e) {
    // A stale/invalid org selector (e.g. an org that was deleted, left behind in
    // localStorage) makes whoami fail with a membership AUTH_ERROR — which would
    // otherwise 403 every request and lock the user out. Drop the selector and
    // retry once (the token is still attached) so they land on their default org.
    // The backend stays strict (a non-member selector is always denied); recovery
    // is client-side.
    if (AUTH.org() && isOrgSelectorErr(e)) {
      AUTH.setOrg(null); // also clears the selected workflow
      try {
        state.me = await api("/v1/whoami");
        state.orgs = state.me.organizations || [];
        return;
      } catch (_e2) { /* fall through to the cleared state */ }
    }
    state.me = null;
    state.orgs = [];
  }
}

// True when an error is a stale/invalid X-Org-Id rejection (not a member, or the
// org no longer exists) — the recoverable case ensureMe() retries past. The match
// runs against api()'s raw error text (`<status> <path>: <json-body>`), so the
// server's quotes around the org id arrive JSON-ESCAPED (organization \"x\" not
// found). Don't anchor on literal quotes — just require the "organization … not
// found" phrase; over-matching here is safe (we only drop a selector and retry).
function isOrgSelectorErr(e) {
  return !!e && typeof e.message === "string" &&
    /not a member of organization|organization\b.*?not found/i.test(e.message);
}

function currentOrgName() {
  const id = state.me?.organizationId;
  const o = (state.orgs || []).find((x) => x.id === id);
  return o ? (o.name || o.slug) : (id ? id.slice(0, 8) : "—");
}

// --- Organisation avatar (initials on a deterministic pastel tile) ----------
// Same seed → same colour, so an org keeps its identity across the switcher,
// the menu header, and the org list.
function orgColor(seed) {
  const palette = [
    ["bg-sky-100", "text-sky-700"], ["bg-violet-100", "text-violet-700"],
    ["bg-emerald-100", "text-emerald-700"], ["bg-amber-100", "text-amber-700"],
    ["bg-rose-100", "text-rose-700"], ["bg-fuchsia-100", "text-fuchsia-700"],
    ["bg-teal-100", "text-teal-700"], ["bg-indigo-100", "text-indigo-700"],
  ];
  const s = String(seed || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function orgInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  const two = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return two.toUpperCase();
}

function orgAvatar(org, sizeCls, textCls) {
  const [bg, fg] = orgColor(org?.id || org?.slug || org?.name);
  return `<span class="inline-flex items-center justify-center rounded-md font-semibold shrink-0 ${bg} ${fg} ${sizeCls} ${textCls}">${escapeHtml(orgInitials(org?.name || org?.slug))}</span>`;
}

// The signed-in user's avatar. Deliberately a *circle* (orgs use rounded
// squares) so person-vs-organisation reads at a glance, on a neutral stone
// tile. A superuser gets an amber ring so the elevated identity is legible on
// the avatar itself even with the account menu closed.
function userAvatar(subject, isSuper, sizeCls = "h-6 w-6", textCls = "text-[11px]") {
  const ring = isSuper ? " ring-2 ring-amber-400/80" : "";
  return `<span class="inline-flex items-center justify-center rounded-full font-semibold shrink-0 bg-stone-600 text-stone-50 ${sizeCls} ${textCls}${ring}">${escapeHtml(orgInitials(subject))}</span>`;
}

// The account dropdown: identity (name + role), a deliberate "you are elevated"
// note for superusers, and Sign out. Anchored under the tenant-bar avatar
// button on the RIGHT edge (right-0), with a transparent full-screen backdrop
// that closes it on any outside click — same idiom as orgMenuPanel().
function accountMenuPanel() {
  const me = state.me;
  const subject = me?.subject || "system";
  const isAdmin = !!me?.isPlatformAdmin;
  const roleLine = isAdmin ? "Platform superuser" : "Member";
  return `
    <div id="acct-menu-backdrop" class="fixed inset-0 z-40"></div>
    <div id="acct-menu" role="menu" aria-label="Account" class="absolute right-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-stone-200 bg-white shadow-xl text-stone-900 overflow-hidden">
      <div class="p-3">
        <div class="flex items-center gap-3">
          ${userAvatar(subject, isAdmin, "h-10 w-10", "text-sm")}
          <div class="min-w-0">
            <div class="font-semibold text-stone-900 truncate">${escapeHtml(subject)}</div>
            <div class="text-xs ${isAdmin ? "text-amber-600 font-medium" : "text-stone-500"} truncate">${roleLine}</div>
          </div>
        </div>
        ${isAdmin ? `<div class="mt-3 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-2.5 py-2 text-[12px] leading-snug text-amber-800"><span class="shrink-0">⚡</span><span>You can act across every organization. Every cross-tenant action is audited.</span></div>` : ""}
      </div>
      <button role="menuitem" id="acct-menu-password" class="w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-stone-200 hover:bg-stone-50 text-left">
        <svg viewBox="0 0 20 20" fill="none" class="h-5 w-5 text-stone-500 shrink-0"><path d="M6 9V6.5a4 4 0 0 1 8 0V9M5 9h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="text-sm font-medium text-stone-800">Change password</span>
      </button>
      <button role="menuitem" id="acct-menu-logout" class="w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-stone-200 hover:bg-stone-50 text-left">
        <svg viewBox="0 0 20 20" fill="none" class="h-5 w-5 text-stone-500 shrink-0"><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3H15a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 15 17H9.5A1.5 1.5 0 0 1 8 15.5V14M11 10H3m0 0l2.5-2.5M3 10l2.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="text-sm font-medium text-stone-800">Sign out</span>
      </button>
    </div>`;
}

// Best-effort member count for the current org's menu-header subtitle. The
// /v1/members read is org-admin gated, so a non-admin simply gets the slug
// fallback — we mark the org as "attempted" up front to avoid refetch storms.
async function loadOrgMemberCount() {
  const orgId = state.me?.organizationId;
  if (!orgId || state.orgMemberCountFor === orgId) return;
  state.orgMemberCountFor = orgId;
  try {
    const members = await api("/v1/members");
    state.orgMemberCount = Array.isArray(members) ? members.length : null;
  } catch (_e) {
    state.orgMemberCount = null;
  }
  if (state.orgMenuOpen) render();
}

// The org dropdown: current org header + admin shortcut, the switchable org
// list, and create-new. Anchored under the tenant-bar avatar button; a
// transparent full-screen backdrop closes it on any outside click.
function orgMenuPanel() {
  const me = state.me;
  const orgs = state.orgs || [];
  const curId = me?.organizationId || "";
  const curOrg = orgs.find((o) => o.id === curId) || { id: curId, name: currentOrgName() };
  const count = state.orgMemberCountFor === curId ? state.orgMemberCount : null;
  const subtitle = count != null
    ? `${count} member${count === 1 ? "" : "s"}`
    : (curOrg.slug ? escapeHtml(curOrg.slug) : "");
  const check = `<svg viewBox="0 0 20 20" fill="none" class="h-4 w-4 text-stone-900 shrink-0"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const list = orgs.map((o) => `
    <button role="menuitem" data-org-pick="${escapeHtml(o.id)}" class="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-stone-100 text-left">
      ${orgAvatar(o, "h-7 w-7", "text-xs")}
      <span class="flex-1 text-sm text-stone-800 truncate">${escapeHtml(o.name || o.slug)}</span>
      ${o.id === curId ? check : ""}
    </button>`).join("") || `<div class="px-2 py-2 text-sm text-stone-400">No organisations.</div>`;
  return `
    <div id="org-menu-backdrop" class="fixed inset-0 z-40"></div>
    <div id="org-menu" role="menu" aria-label="Organisations" class="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-xl border border-stone-200 bg-white shadow-xl text-stone-900 overflow-hidden">
      <div class="p-3">
        <div class="flex items-center gap-3">
          ${orgAvatar(curOrg, "h-10 w-10", "text-sm")}
          <div class="min-w-0">
            <div class="font-semibold text-stone-900 truncate">${escapeHtml(curOrg.name || currentOrgName())}</div>
            ${subtitle ? `<div class="text-xs text-stone-500 truncate">${subtitle}</div>` : ""}
          </div>
        </div>
        <button role="menuitem" id="org-menu-admin" class="mt-3 w-full px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 text-left font-medium text-stone-800">Organisation admin</button>
      </div>
      <div class="border-t border-stone-200 p-2">
        <div class="px-2 pt-1 pb-1.5 text-[11px] uppercase tracking-wide text-stone-400 font-semibold">My organisations</div>
        <div class="max-h-64 overflow-auto">${list}</div>
      </div>
      <button role="menuitem" id="org-menu-create" class="w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-stone-200 hover:bg-stone-50 text-left">
        <span class="inline-flex items-center justify-center h-7 w-7 rounded-md border border-stone-300 text-stone-500 text-lg leading-none">+</span>
        <span class="text-sm font-medium text-stone-800">Create new organisation</span>
      </button>
    </div>`;
}

// A single, uniform monochrome glyph shared by every workflow row and the
// switcher trigger. Unlike orgAvatar (per-org colour identity), workflows
// deliberately get NO per-item colour: the org owns the one colour identity in
// the tenant bar, and a uniform glyph keeps the nested workflow list reading as
// a clean set. Inherits its colour from the surrounding text via currentColor.
function workflowGlyph(cls) {
  return `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" class="shrink-0 ${cls}"><rect x="2.5" y="3" width="7" height="5" rx="1.3" stroke="currentColor" stroke-width="1.4"/><rect x="10.5" y="12" width="7" height="5" rx="1.3" stroke="currentColor" stroke-width="1.4"/><path d="M6 8v3a1.5 1.5 0 0 0 1.5 1.5H10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// The workflow switcher dropdown. A stripped-down sibling of orgMenuPanel():
// no header block, no "current" row, no admin shortcut — just the switchable
// list (uniform glyph + name, a check on the active one) and a create-new row.
// Anchored under the tenant-bar workflow trigger; a transparent backdrop closes
// it on any outside click.
function workflowMenuPanel() {
  const workflows = state.me?.workflows || [];
  const curId = AUTH.workflow() || "";
  const check = `<svg viewBox="0 0 20 20" fill="none" class="h-4 w-4 text-stone-900 shrink-0"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const allRow = `
    <button role="menuitem" id="wf-menu-all" class="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-stone-100 text-left ${!curId ? "bg-stone-100" : ""}">
      ${workflowGlyph("h-5 w-5 text-stone-400")}
      <span class="flex-1 text-sm truncate ${!curId ? "text-stone-900 font-medium" : "text-stone-800"}">All workflows</span>
      ${!curId ? check : ""}
    </button>
    <div class="my-1 border-t border-stone-100"></div>`;
  const list = workflows.map((w) => {
    const active = w.id === curId;
    return `
    <button role="menuitem" data-wf-pick="${escapeHtml(w.id)}" class="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-stone-100 text-left ${active ? "bg-stone-100" : ""}">
      ${workflowGlyph("h-5 w-5 text-stone-400")}
      <span class="flex-1 text-sm truncate ${active ? "text-stone-900 font-medium" : "text-stone-800"}">${escapeHtml(w.name)}</span>
      ${active ? check : ""}
    </button>`;
  }).join("") || `<div class="px-2 py-2 text-sm text-stone-400">No workflows.</div>`;
  return `
    <div id="wf-menu-backdrop" class="fixed inset-0 z-40"></div>
    <div id="wf-menu" role="menu" aria-label="Workflows" class="absolute left-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-stone-200 bg-white shadow-xl text-stone-900 overflow-hidden">
      <div class="p-2">
        <div class="max-h-72 overflow-auto">${allRow}${list}</div>
      </div>
      <button role="menuitem" id="wf-menu-create" class="w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-stone-200 hover:bg-stone-50 text-left">
        <span class="inline-flex items-center justify-center h-7 w-7 rounded-md border border-stone-300 text-stone-500 text-lg leading-none">+</span>
        <span class="text-sm font-medium text-stone-800">Create new workflow</span>
      </button>
    </div>`;
}

// The Qlerify diamond mark (from the app's favicon.svg), inlined so it inherits
// the surrounding text colour via currentColor — white on the dark tenant bar,
// brand green on the light login card.
function qlerifyMark(cls) {
  return `<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" class="shrink-0 ${cls}"><path d="M23.7425 23.7122H29.5003C29.5169 23.7124 29.5305 23.7259 29.5306 23.7425V29.5003C29.5304 29.5168 29.5168 29.5304 29.5003 29.5306H23.7425C23.7259 29.5305 23.7124 29.5169 23.7122 29.5003V23.7425C23.7123 23.7258 23.7258 23.7123 23.7425 23.7122Z"/><path d="M15.0404 27.8003L3.07345 15.8334C2.8545 15.6144 2.85461 15.2597 3.07345 15.0406L15.0404 3.0737C15.2594 2.8547 15.6141 2.8547 15.8331 3.0737L27.8001 15.0406C28.0189 15.2597 28.019 15.6144 27.8001 15.8334L15.8331 27.8003C15.6142 28.0191 15.2594 28.0191 15.0404 27.8003Z"/></svg>`;
}

const menuCaret = `<svg viewBox="0 0 20 20" fill="none" class="h-3.5 w-3.5 text-stone-400 shrink-0"><path d="M7 8l3-3 3 3M7 12l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function selectedWorkflowId() {
  return AUTH.workflow() || "";
}

function workflowBreadcrumbLabel() {
  const workflows = state.me?.workflows || [];
  const id = selectedWorkflowId();
  if (!id) return "All workflows";
  return (workflows.find((w) => w.id === id) || {}).name || "Workflow";
}

function showWorkflowSectionBar() {
  return WORKFLOW_SCOPED_VIEWS.has(state.view) && !!selectedWorkflowId();
}

function sectionTab(href, label, active, title) {
  const cls = active
    ? "border-stone-900 text-stone-900 font-medium"
    : "border-transparent text-stone-500 hover:text-stone-800 hover:border-stone-300";
  return `<a href="${href}" class="py-2.5 -mb-px border-b-2 ${cls} whitespace-nowrap" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`;
}

// ---------------------------------------------------------------------------
// Connectors tab (#connectors) — workflow-wide inventory of data connectors:
// active + orphaned, with detail, re-point, and delete. This is the ONLY home for
// orphaned connectors (whose target table was renamed/removed), and re-point is
// the deliberate manual recovery path (no automatic rename detection).
// ---------------------------------------------------------------------------

async function loadConnectors() {
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

function connectorsView() {
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

function bindConnectors() {
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

function disposeConnMonaco() {
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

function sectionBar() {
  if (!showWorkflowSectionBar()) return "";
  const overviewActive = state.view === "dashboard" || state.view === "detail" || state.view === "flow" || state.view === "rows";
  const modelActive = state.view === "model";
  const systemsActive = state.view === "bcs";
  const connectorsActive = state.view === "connectors";
  return `
    <div class="bg-stone-50 text-sm border-b border-stone-200">
      <div class="px-6 flex items-center gap-6">
        ${sectionTab("#", "Overview", overviewActive, "Live ops — instances in flight for this workflow")}
        ${sectionTab("#model", "Model", modelActive, "Qlerify model — versions, source link, and workflow.json")}
        ${sectionTab("#bcs", "Systems", systemsActive, "Data sources and connectors for this workflow")}
        ${sectionTab("#connectors", "Connectors", connectorsActive, "All data connectors for this workflow — details, re-point, delete")}
      </div>
    </div>`;
}

function tenantBar() {
  const me = state.me;
  const subject = me?.subject || "system";
  const isAdmin = !!me?.isPlatformAdmin;
  const orgs = state.orgs || [];
  const curId = me?.organizationId || "";
  const curOrg = orgs.find((o) => o.id === curId) || { id: curId, name: currentOrgName() };
  const workflows = me?.workflows || [];
  const emptyOrg = workflows.length === 0;
  const wfLabel = workflowBreadcrumbLabel();
  const wfHomeHref = selectedWorkflowId() ? "#" : "#org";
  const projControl = emptyOrg
    ? `<button id="wf-empty-create" class="text-sm text-amber-300 hover:text-amber-200" title="This organization has no workflows yet">+ Create workflow</button>`
    : `<div class="relative flex items-center rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800" id="wf-menu-wrap">
          <a id="wf-home" href="${wfHomeHref}" class="flex items-center gap-2 pl-1.5 pr-1 py-0.5 rounded-l-md" title="${selectedWorkflowId() ? "This workflow's overview" : "Organisation portfolio — all workflows"}">
            ${workflowGlyph("h-4 w-4 text-stone-400")}
            <span class="text-sm font-medium text-stone-100 max-w-[220px] truncate">${escapeHtml(wfLabel)}</span>
          </a>
          <button id="wf-menu-btn" type="button" aria-haspopup="menu" aria-expanded="${state.wfMenuOpen ? "true" : "false"}" class="px-1.5 py-1 rounded-r-md border-l border-stone-700/60" title="Switch workflow">
            ${menuCaret}
          </button>
          ${state.wfMenuOpen ? workflowMenuPanel() : ""}
        </div>`;
  return `
    <div class="bg-stone-900 text-stone-300 text-sm border-b border-stone-800">
      <div class="px-6 py-1.5 flex items-center gap-3">
        <button id="logo-home" type="button" class="flex items-center gap-1.5 text-stone-100 rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800 px-1 py-0.5" title="Portfolio — all workflows">
          ${qlerifyMark("h-4 w-4")}<span class="font-semibold tracking-tight">Qlerify<span class="text-amber-400">·</span>Live</span>
        </button>
        <span class="text-stone-500">›</span>
        <div class="relative flex items-center rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800" id="org-menu-wrap">
          <a id="org-home" href="#org" class="flex items-center gap-2 pl-1 pr-1 py-0.5 rounded-l-md" title="Organisation portfolio">
            ${orgAvatar(curOrg, "h-6 w-6", "text-[11px]")}
            <span class="text-sm font-medium text-stone-100 max-w-[220px] truncate">${escapeHtml(currentOrgName())}</span>
          </a>
          <button id="org-menu-btn" type="button" aria-haspopup="menu" aria-expanded="${state.orgMenuOpen ? "true" : "false"}" class="px-1.5 py-1 rounded-r-md border-l border-stone-700/60" title="Switch organisation">
            ${menuCaret}
          </button>
          ${state.orgMenuOpen ? orgMenuPanel() : ""}
        </div>
        <span class="text-stone-500">›</span>
        ${projControl}
        <div class="flex-1"></div>
        <div class="relative" id="acct-menu-wrap">
          <button id="acct-menu-btn" aria-haspopup="menu" aria-expanded="${state.acctMenuOpen ? "true" : "false"}" class="flex items-center gap-2 rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800 pl-1 pr-1.5 py-0.5" title="Account — signed in as ${escapeHtml(subject)}">
            ${isAdmin ? `<span class="text-[10px] uppercase font-bold tracking-wide px-1.5 py-px rounded bg-amber-500 text-stone-900" title="You are signed in as a platform superuser — you can act across every organization, and every cross-tenant action is audited">Superuser</span>` : ""}
            ${userAvatar(subject, isAdmin)}
            ${menuCaret}
          </button>
          ${state.acctMenuOpen ? accountMenuPanel() : ""}
        </div>
      </div>
    </div>`;
}

function bindTenantBar() {
  // --- Scope navigation (logo / org name → portfolio; workflow name → overview) -
  document.getElementById("logo-home")?.addEventListener("click", (e) => {
    e.preventDefault();
    state.orgMenuOpen = false;
    state.wfMenuOpen = false;
    AUTH.setWorkflow(null); // the logo is the org's home: defocus to the full portfolio
    if (state.view === "org") { render(); return; } // already there — just drop the focus
    navigate("#org");
  });

  // --- Account menu (avatar dropdown: identity + sign out) ------------------
  // Dismiss without acting (Escape / outside-click): close and return focus to
  // the trigger so a keyboard user isn't dropped onto <body> by the re-render.
  const dismissAcctMenu = () => { state.acctMenuOpen = false; render(); document.getElementById("acct-menu-btn")?.focus(); };
  document.getElementById("acct-menu-btn")?.addEventListener("click", () => { state.acctMenuOpen = !state.acctMenuOpen; render(); });
  document.getElementById("acct-menu-backdrop")?.addEventListener("click", dismissAcctMenu);
  document.getElementById("acct-menu-password")?.addEventListener("click", () => {
    state.acctMenuOpen = false;
    state.cpForced = false;
    state.cpError = null;
    state.cpReturn = location.hash || "#org"; // return here on cancel/success
    state.view = "change-password";
    render();
  });
  document.getElementById("acct-menu-logout")?.addEventListener("click", async () => {
    state.acctMenuOpen = false;
    try { await api("/v1/auth/logout", { method: "POST", body: "{}" }); } catch (_e) { /* ignore */ }
    AUTH.clear();
    state.me = null; state.orgs = [];
    navigate("#login");
  });

  // Create-organization dialog (self-service: POST /v1/organizations makes the
  // caller the owner). The new org provisions a default workspace but no workflow,
  // so switching into it lands on the empty-org "create your first workflow" view.
  const createOrg = async () => {
    if (state.newOrgBusy) return;
    const name = (document.getElementById("new-org-name")?.value || state.newOrgName || "").trim();
    if (!name) { state.newOrgErr = "Organization name is required"; render(); return; }
    state.newOrgBusy = true; state.newOrgErr = null; render();
    try {
      const org = await api("/v1/organizations", { method: "POST", body: JSON.stringify({ name }) });
      AUTH.setOrg(org.id); // switch into the brand-new org (also clears the selected workflow)
      state.newOrgOpen = false; state.newOrgBusy = false; state.newOrgName = "";
      state.me = null; // force a fresh whoami so the breadcrumb + switcher reflect the new org
      state.modelMsg = { ok: true, text: `Organization "${name}" created — you're its owner. Create your first workflow to get started.` };
      navigate("#"); // empty new org → the create-first-workflow screen
      setTimeout(() => { state.modelMsg = null; render(); }, 3000);
    } catch (e) {
      state.newOrgBusy = false;
      state.newOrgErr = (e && e.message) ? e.message : "Failed to create the organization.";
      render();
    }
  };
  // Create-workflow dialog. A new workflow lands in the org's first workspace
  // (the same default the empty-org view uses). The model is MANDATORY and sent
  // with the create call — the server creates workflow + model atomically (and
  // rolls the workflow back if the model is bad), so we only switch into it on
  // success. Mirrors createOrg's open/busy/err state pattern.
  const createWorkflow = async () => {
    if (state.newWfBusy) return;
    const name = (document.getElementById("new-wf-name")?.value || state.newWfName || "").trim();
    if (!name) { state.newWfErr = "Workflow name is required"; render(); return; }
    const url = (document.getElementById("new-wf-url")?.value || state.newWfUrl || "").trim();
    const text = (document.getElementById("new-wf-text")?.value || state.newWfText || "").trim();
    let modelPayload;
    if (url) {
      modelPayload = { sourceUrl: url }; // primary: pull from the Qlerify modeller
    } else if (text) {
      try { JSON.parse(text); } catch (_e) { state.newWfErr = "The pasted/uploaded model isn't valid JSON."; render(); return; }
      modelPayload = { workflow: text }; // secondary: uploaded / pasted workflow.json
    } else {
      state.newWfErr = "A model is required — paste a Qlerify link (or upload/paste a workflow.json under Advanced)."; render(); return;
    }
    state.newWfBusy = true; state.newWfErr = null; render();
    showOverlay("Creating workflow…");
    try {
      const wss = await api("/v1/workspaces");
      const workspaceId = (wss[0] || {}).id;
      if (!workspaceId) throw new Error("This org has no workspace — create one in Org Admin first.");
      const wf = await api("/v1/workflows", { method: "POST", body: JSON.stringify({ name, workspaceId, ...modelPayload }) });
      AUTH.setWorkflow(wf.id); // switch straight into the brand-new workflow
      state.newWfOpen = false; state.newWfBusy = false; state.newWfName = ""; state.newWfUrl = ""; state.newWfText = "";
      state.me = null; // force a fresh whoami so the breadcrumb + switcher reflect the new workflow
      navigate("#"); // a workflow now always has a model → straight to its dashboard
    } catch (e) {
      state.newWfBusy = false;
      state.newWfErr = (e && e.message) ? e.message : "Failed to create the workflow.";
      render();
    } finally {
      hideOverlay();
    }
  };
  // --- Workflow menu (switcher dropdown: all / switch / create) ---------------
  const dismissWfMenu = () => { state.wfMenuOpen = false; render(); document.getElementById("wf-menu-btn")?.focus(); };
  document.getElementById("wf-menu-btn")?.addEventListener("click", (e) => { e.stopPropagation(); state.wfMenuOpen = !state.wfMenuOpen; render(); });
  document.getElementById("wf-menu-backdrop")?.addEventListener("click", dismissWfMenu);
  const selectAllWorkflows = () => {
    state.wfMenuOpen = false;
    AUTH.setWorkflow(null); // deselect → the unfiltered, org-wide portfolio
    if (state.view === "org") { render(); return; } // already on the portfolio — just defocus
    navigate("#org");
  };
  document.getElementById("wf-menu-all")?.addEventListener("click", selectAllWorkflows);
  document.querySelectorAll("[data-wf-pick]").forEach((el) => el.addEventListener("click", async () => {
    const id = el.getAttribute("data-wf-pick");
    state.wfMenuOpen = false;
    if (id === AUTH.workflow()) { render(); return; }
    await withOverlay("Loading workflow…", async () => {
      AUTH.setWorkflow(id);
      state.me = null;
      await ensureMe();
      if (state.view === "org" || (location.hash || "").startsWith("#org")) navigate("#");
      else await onHashChange();
    });
  }));
  const openCreateWorkflow = () => {
    state.wfMenuOpen = false;
    state.newWfOpen = true; state.newWfErr = null; state.newWfName = ""; state.newWfUrl = ""; state.newWfText = "";
    render();
    setTimeout(() => document.getElementById("new-wf-name")?.focus(), 30);
  };
  document.getElementById("wf-menu-create")?.addEventListener("click", openCreateWorkflow);
  document.getElementById("wf-empty-create")?.addEventListener("click", openCreateWorkflow);
  document.getElementById("new-wf-cancel")?.addEventListener("click", () => { state.newWfOpen = false; render(); });
  document.getElementById("new-wf-name")?.addEventListener("input", (e) => { state.newWfName = e.target.value; });
  // Enter in the name field submits; in the URL field it also submits (mirrors the single-line feel).
  document.getElementById("new-wf-name")?.addEventListener("keydown", (e) => { if (e.key === "Enter") createWorkflow(); });
  document.getElementById("new-wf-url")?.addEventListener("input", (e) => { state.newWfUrl = e.target.value; });
  document.getElementById("new-wf-url")?.addEventListener("keydown", (e) => { if (e.key === "Enter") createWorkflow(); });
  // Don't re-render on file load (it would collapse the <details>); fill the textarea directly.
  document.getElementById("new-wf-file")?.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      state.newWfText = String(r.result || "");
      const ta = document.getElementById("new-wf-text");
      if (ta) ta.value = state.newWfText;
    };
    r.readAsText(f);
  });
  document.getElementById("new-wf-text")?.addEventListener("input", (e) => { state.newWfText = e.target.value; });
  document.getElementById("new-wf-create")?.addEventListener("click", createWorkflow);

  // --- Organisation menu (caret dropdown: switch / admin / create) ----------
  // Dismiss without acting (Escape / outside-click): close and return focus to
  // the trigger so a keyboard user isn't dropped onto <body> by the re-render.
  const dismissOrgMenu = () => { state.orgMenuOpen = false; render(); document.getElementById("org-menu-btn")?.focus(); };
  document.getElementById("org-menu-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    state.orgMenuOpen = !state.orgMenuOpen;
    if (state.orgMenuOpen) loadOrgMemberCount();
    render();
  });
  document.getElementById("org-menu-backdrop")?.addEventListener("click", dismissOrgMenu);
  document.getElementById("org-menu-admin")?.addEventListener("click", () => { state.orgMenuOpen = false; navigate("#admin"); });
  document.querySelectorAll("[data-org-pick]").forEach((el) => el.addEventListener("click", async () => {
    const id = el.getAttribute("data-org-pick");
    state.orgMenuOpen = false;
    if (id === (state.me?.organizationId || "")) { render(); return; }
    state.orgMemberCount = null; state.orgMemberCountFor = null; // invalidate the cached subtitle for the new org
    await withOverlay("Switching organisation…", async () => {
      AUTH.setOrg(id); // also clears the selected workflow
      await onHashChange(); // reloads whoami + the current view for the newly selected org
    });
  }));
  document.getElementById("org-menu-create")?.addEventListener("click", () => {
    state.orgMenuOpen = false;
    state.newOrgOpen = true; state.newOrgErr = null; state.newOrgName = "";
    render();
    setTimeout(() => document.getElementById("new-org-name")?.focus(), 30);
  });
  // Close whichever switcher menu is open on Escape — bound once for the app's lifetime.
  if (!bindTenantBar._escBound) {
    bindTenantBar._escBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.orgMenuOpen) dismissOrgMenu();
      else if (state.wfMenuOpen) dismissWfMenu();
      else if (state.acctMenuOpen) dismissAcctMenu();
    });
  }
  document.getElementById("new-org-cancel")?.addEventListener("click", () => { state.newOrgOpen = false; render(); });
  document.getElementById("new-org-name")?.addEventListener("input", (e) => { state.newOrgName = e.target.value; });
  document.getElementById("new-org-name")?.addEventListener("keydown", (e) => { if (e.key === "Enter") createOrg(); });
  document.getElementById("new-org-create")?.addEventListener("click", createOrg);
}

// Self-service create-organization modal, opened from the tenant bar's "+ New org"
// button. Mirrors the model-replace form's open/busy/err state pattern.
function newOrgDialog() {
  if (!state.newOrgOpen) return "";
  const err = state.newOrgErr ? `<div class="text-sm text-rose-600 mb-3">${escapeHtml(state.newOrgErr)}</div>` : "";
  return `
    <div class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col">
        <div class="px-5 py-4 border-b border-stone-200">
          <div class="text-lg font-semibold">Create organization</div>
          <div class="text-sm text-stone-500 mt-0.5">A new tenant with its own members, workflows, and data. You become its owner — it starts empty, ready for your first workflow.</div>
        </div>
        <div class="p-5">
          ${err}
          <label class="block text-sm font-medium text-stone-700 mb-1">Organization name</label>
          <input id="new-org-name" value="${escapeHtml(state.newOrgName || "")}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="Acme Corp" />
          <div class="text-xs text-stone-500 mt-1">A URL-safe handle (slug) is derived from the name automatically.</div>
        </div>
        <div class="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2">
          <button id="new-org-cancel" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
          <button id="new-org-create" ${state.newOrgBusy ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">${state.newOrgBusy ? "Creating…" : "Create organization"}</button>
        </div>
      </div>
    </div>`;
}

// Self-service create-workflow modal, opened from the workflow switcher's
// "Create new workflow" row (or the empty-org "Create your first workflow"
// trigger). A model is MANDATORY at creation — the workflow and its model are
// created together (server-side atomic), so an empty, model-less workflow can
// never exist. Mirrors newOrgDialog()'s open/busy/err state pattern.
function newWfDialog() {
  if (!state.newWfOpen) return "";
  const err = state.newWfErr ? `<div class="text-sm text-rose-600 mb-3">${escapeHtml(state.newWfErr)}</div>` : "";
  return `
    <div class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[88vh]">
        <div class="px-5 py-4 border-b border-stone-200">
          <div class="text-lg font-semibold">Create workflow</div>
          <div class="text-sm text-stone-500 mt-0.5">Name it and point it at a Qlerify model — they're created together. A workflow is its model, so there's no empty state to fill in later.</div>
        </div>
        <div class="p-5 overflow-auto flex-1">
          ${err}
          <label class="block text-sm font-medium text-stone-700 mb-1">Workflow name</label>
          <input id="new-wf-name" value="${escapeHtml(state.newWfName || "")}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="Q3 Forecast" />
          <label class="block text-sm font-medium text-stone-700 mb-1 mt-4">Qlerify model link</label>
          <input id="new-wf-url" type="url" value="${escapeHtml(state.newWfUrl || "")}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="https://app.qlerify.com/workflow/&lt;projectId&gt;/&lt;workflowId&gt;" />
          <div class="text-xs text-stone-500 mt-1">Paste the workflow URL from the Qlerify modeller — we'll pull the latest model.</div>
          <details class="mt-4">
            <summary class="text-sm text-stone-600 cursor-pointer select-none hover:text-stone-900">Advanced — upload or paste a workflow.json instead</summary>
            <div class="mt-3">
              <div class="mb-2 flex items-center gap-2">
                <input id="new-wf-file" type="file" accept=".json,application/json" class="text-sm" />
                <span class="text-xs text-stone-400">— or paste below —</span>
              </div>
              <textarea id="new-wf-text" class="w-full h-40 rounded-md border border-stone-300 p-2 text-xs mono" placeholder='{ "boundedContext": "...", "domainEvents": { ... } }'>${escapeHtml(state.newWfText || "")}</textarea>
            </div>
          </details>
        </div>
        <div class="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2">
          <button id="new-wf-cancel" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
          <button id="new-wf-create" ${state.newWfBusy ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">${state.newWfBusy ? "Creating…" : "Create workflow"}</button>
        </div>
      </div>
    </div>`;
}

// Empty-org state: the org has zero workflows (e.g. its last was deleted). The
// data plane fails closed (409), so we show a create-your-first-workflow panel
// instead of a broken dashboard.
function emptyOrgView() {
  return `
    <main class="flex-1 flex items-center justify-center p-8">
      <div class="w-full max-w-md rounded-xl border border-stone-200 bg-white p-6 shadow-sm text-center">
        <div class="text-3xl mb-2">📁</div>
        <div class="text-lg font-semibold text-stone-900">No workflows yet</div>
        <div class="text-sm text-stone-500 mt-1 mb-5">This organization is empty. Create your first workflow — you'll point it at your own Qlerify model as part of creating it.</div>
        <div class="text-left">
          <button id="empty-proj-create" class="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800">Create your first workflow</button>
          <div class="text-[11px] text-stone-400 mt-3">You can also manage workflows from <a href="#admin" class="underline">Org Admin</a>.</div>
        </div>
      </div>
    </main>`;
}

// Opening the create dialog (which now collects the mandatory model) is the only
// create path — the empty-org button just opens it. The dialog itself is mounted
// globally (it's in wrap()), and its handlers are bound by bindTenantBar().
function bindEmptyOrg() {
  document.getElementById("empty-proj-create")?.addEventListener("click", () => {
    state.newWfOpen = true; state.newWfErr = null; state.newWfName = ""; state.newWfUrl = ""; state.newWfText = "";
    render();
    setTimeout(() => document.getElementById("new-wf-name")?.focus(), 30);
  });
}

// Signed in but not a member of any organisation yet → create the first one (you
// become its owner). Distinct from emptyOrgView, which is for an org that exists
// but has no workflows. A platform admin who can see existing orgs also gets a
// list to open one (break-glass).
function noOrgView() {
  const err = state.newOrgErr ? `<div class="text-xs text-rose-600 mt-2">${escapeHtml(state.newOrgErr)}</div>` : "";
  const orgs = state.me?.organizations || [];
  const switchList = orgs.length ? `
        <div class="mt-5 pt-5 border-t border-stone-200 text-left">
          <div class="text-xs text-stone-500 mb-2">Or open an existing organisation</div>
          <div class="space-y-1">
            ${orgs.map((o) => `<button data-org="${escapeHtml(o.id)}" class="firstorg-switch w-full text-left px-3 py-2 rounded-md border border-stone-200 hover:bg-stone-50 text-sm">${escapeHtml(o.name || o.slug)}</button>`).join("")}
          </div>
        </div>` : "";
  return `
    <main class="flex-1 flex items-center justify-center p-8">
      <div class="w-full max-w-md rounded-xl border border-stone-200 bg-white p-6 shadow-sm text-center">
        <div class="text-3xl mb-2">🏢</div>
        <div class="text-lg font-semibold text-stone-900">Create your first organisation</div>
        <div class="text-sm text-stone-500 mt-1 mb-5">You're signed in but not a member of any organisation yet. Create one to get started — you'll be its owner, and can add a workspace and workflow next.</div>
        <div class="text-left">
          <label class="block text-xs text-stone-500 mb-1">Organisation name</label>
          <input id="firstorg-name" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3" placeholder="Acme Corp" />
          <button id="firstorg-create" class="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800">Create organisation</button>
          ${err}
        </div>
        ${switchList}
      </div>
    </main>`;
}

function bindNoOrg() {
  const create = async () => {
    const name = (document.getElementById("firstorg-name")?.value || "").trim();
    if (!name) { state.newOrgErr = "Organisation name is required"; render(); return; }
    state.newOrgErr = null;
    try {
      const org = await api("/v1/organizations", { method: "POST", body: JSON.stringify({ name }) });
      AUTH.setOrg(org.id);   // land in the brand-new org (you're its owner)
      state.me = null;       // force a fresh whoami for the new context
      navigate("#");
    } catch (e) {
      state.newOrgErr = (e && e.message) ? e.message : "Failed to create the organisation.";
      render();
    }
  };
  document.getElementById("firstorg-create")?.addEventListener("click", create);
  document.getElementById("firstorg-name")?.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
  document.querySelectorAll(".firstorg-switch").forEach((b) => b.addEventListener("click", () => {
    AUTH.setOrg(b.getAttribute("data-org")); state.me = null; navigate("#");
  }));
}

function loginView() {
  const err = state.loginError ? `<div class="text-sm text-rose-600 mb-3">${escapeHtml(state.loginError)}</div>` : "";
  return `
    <div class="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
      <form id="login-form" class="w-80 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <div class="flex items-center gap-2 mb-1"><span style="color:#50E593">${qlerifyMark("h-6 w-6")}</span><span class="text-lg font-semibold">Qlerify<span class="text-amber-500">·</span>Live</span></div>
        <div class="text-sm text-stone-500 mb-4">Sign in to the multi-tenant console</div>
        ${err}
        <label class="block text-xs font-medium text-stone-600 mb-1">Username</label>
        <input id="login-subject" autocomplete="username" class="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="superadmin" />
        <label class="block text-xs font-medium text-stone-600 mb-1">Password</label>
        <input id="login-password" type="password" autocomplete="current-password" class="w-full mb-4 rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <button class="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800">Sign in</button>
      </form>
    </div>`;
}

function bindLogin() {
  document.getElementById("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const subject = document.getElementById("login-subject").value.trim();
    const password = document.getElementById("login-password").value;
    state.loginError = null;
    AUTH.clear(); // never attach a stale token to the login request
    try {
      const r = await api("/v1/auth/login", { method: "POST", body: JSON.stringify({ subject, password }) });
      AUTH.setSession(r.token);
      AUTH.setOrg((r.organizations || [])[0]?.id || "");
      state.me = null;
      navigate("#org"); // land on the portfolio control tower after login
    } catch (_err) {
      state.loginError = "Invalid username or password.";
      render();
    }
  });
}

// --- Change password (forced first-use, or from the account menu) -----------
// Full-screen card mirroring loginView. When `state.cpForced` (an admin-issued
// temporary password) there is no escape — the member must set their own before
// anything else loads. From the account menu it is cancellable.
function changePasswordView() {
  const forced = !!state.cpForced;
  const err = state.cpError ? `<div class="text-sm text-rose-600 mb-3">${escapeHtml(state.cpError)}</div>` : "";
  const intro = forced
    ? `<div class="text-sm text-stone-500 mb-4">Your account uses a temporary password. Set your own to continue.</div>`
    : `<div class="text-sm text-stone-500 mb-4">Update the password for <span class="font-medium">${escapeHtml(state.me?.subject || "")}</span>.</div>`;
  const cancel = forced ? "" : `<button type="button" id="cp-cancel" class="w-full mt-2 rounded-md border border-stone-300 py-2 text-sm hover:bg-stone-50">Cancel</button>`;
  return `
    <div class="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
      <form id="cp-form" class="w-80 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <div class="flex items-center gap-2 mb-1"><span style="color:#50E593">${qlerifyMark("h-6 w-6")}</span><span class="text-lg font-semibold">Qlerify<span class="text-amber-500">·</span>Live</span></div>
        <div class="text-base font-semibold text-stone-800 mb-1">Change password</div>
        ${intro}
        ${err}
        <label class="block text-xs font-medium text-stone-600 mb-1">Current password</label>
        <input id="cp-current" type="password" autocomplete="current-password" class="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <label class="block text-xs font-medium text-stone-600 mb-1">New password</label>
        <input id="cp-new" type="password" autocomplete="new-password" class="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <label class="block text-xs font-medium text-stone-600 mb-1">Confirm new password</label>
        <input id="cp-confirm" type="password" autocomplete="new-password" class="w-full mb-4 rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <button class="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800">Update password</button>
        ${cancel}
      </form>
    </div>`;
}

function bindChangePassword() {
  document.getElementById("cp-cancel")?.addEventListener("click", () => {
    state.cpError = null;
    navigate(state.cpReturn || "#org");
  });
  document.getElementById("cp-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById("cp-current").value;
    const newPassword = document.getElementById("cp-new").value;
    const confirm = document.getElementById("cp-confirm").value;
    state.cpError = null;
    if (newPassword !== confirm) { state.cpError = "The new passwords don't match."; render(); return; }
    if (newPassword.length < 10) { state.cpError = "New password must be at least 10 characters."; render(); return; }
    try {
      const r = await api("/v1/account/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      if (r.token) AUTH.setSession(r.token); // server revoked the old sessions; swap to the fresh token
      state.cpForced = false;
      state.cpError = null;
      state.me = null; // re-fetch whoami — mustChangePassword is now false
      navigate(state.cpReturn || "#org");
    } catch (_err) {
      state.cpError = "Couldn't update the password — check your current password.";
      render();
    }
  });
}

// --- Org Admin page --------------------------------------------------------

async function loadAdmin() {
  const tab = state.admin?.tab || "general";
  const orgId = state.me?.organizationId;
  const [members, roles, markings, environments, workspaces, workflows, audit, anthropic, qlerify] = await Promise.all([
    api("/v1/members").catch(() => []),
    api("/v1/role-assignments").catch(() => []),
    api("/v1/markings").catch(() => []),
    api("/v1/environments").catch(() => []),
    api("/v1/workspaces").catch(() => []),
    api("/v1/workflows").catch(() => []),
    api("/v1/audit?limit=60").catch(() => []),
    orgId ? api(`/v1/organizations/${encodeURIComponent(orgId)}/anthropic-config`).catch(() => null) : Promise.resolve(null),
    orgId ? api(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`).catch(() => null) : Promise.resolve(null),
  ]);
  state.admin = { tab, members, roles, markings, environments, workspaces, workflows, audit, anthropic, qlerify };
  render();
}

// One-time display of a freshly issued temporary password (member invite or admin
// reset). Held in state.issuedCredential, never refetched — cleared on dismiss or
// any navigation, so the secret doesn't linger on screen.
function issuedCredentialBanner() {
  const c = state.issuedCredential;
  if (!c) return "";
  return `
    <div class="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-sm font-medium text-amber-900">Temporary password for <span class="mono">${escapeHtml(c.subject)}</span></div>
          <div class="mt-1.5 flex items-center gap-2">
            <code class="mono text-sm bg-white border border-amber-200 rounded px-2 py-1 select-all">${escapeHtml(c.password)}</code>
            <button id="issued-copy" class="text-xs px-2 py-1 rounded border border-amber-300 text-amber-800 hover:bg-amber-100">Copy</button>
          </div>
          <div class="text-xs text-amber-700 mt-1.5">Shown once. Share it over a secure channel; the member must change it on first sign-in.</div>
        </div>
        <button id="issued-dismiss" aria-label="Dismiss" class="text-amber-700 hover:text-amber-900 text-lg leading-none">×</button>
      </div>
    </div>`;
}

const ADMIN_TABS = [["general", "General"], ["members", "Members"], ["roles", "Roles"], ["markings", "Markings"], ["environments", "Environments"], ["workspaces", "Workspaces"], ["workflows", "Workflows"], ["audit", "Audit log"]];

function adminView() {
  const a = state.admin || { tab: "general" };
  const tab = a.tab || "general";
  const tabBtns = ADMIN_TABS.map(([k, label]) =>
    `<button data-admin-tab="${k}" class="px-3 py-1.5 text-sm rounded-md ${tab === k ? "bg-stone-900 text-white" : "border border-stone-300 bg-white hover:bg-stone-50"}">${label}</button>`).join("");
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 pt-4 pb-2 flex items-center gap-4">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Organization admin</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">${escapeHtml(currentOrgName())}</div>
        </div>
      </div>
      <div class="px-6 pb-3 flex items-center gap-2">${tabBtns}</div>
    </header>
    <main class="flex-1 overflow-auto p-6">${adminTabContent(tab, a)}</main>`;
}

function tbl(headers, rowsHtml, empty) {
  return `<div class="rounded-lg border border-stone-200 bg-white overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-stone-50 border-b border-stone-200"><tr class="text-left text-[11px] uppercase tracking-wide text-stone-500">${headers.map((h) => `<th class="px-4 py-2 font-medium">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-stone-100">${rowsHtml || `<tr><td class="px-4 py-6 text-stone-400" colspan="${headers.length}">${empty || "Nothing here yet."}</td></tr>`}</tbody>
    </table></div>`;
}

function roleChip(k) {
  const tone = { owner: "bg-purple-100 text-purple-800", org_admin: "bg-purple-100 text-purple-800", editor: "bg-sky-100 text-sky-800", viewer: "bg-stone-200 text-stone-700", deployer: "bg-amber-100 text-amber-800" }[k] || "bg-stone-200 text-stone-700";
  return `<span class="text-[11px] px-1.5 py-px rounded ${tone}">${escapeHtml(k)}</span>`;
}

// A handful of current Claude models the org can pin (empty = platform default).
// Keep IDs exact — they're validated against the Anthropic API on save.
const ANTHROPIC_MODELS = [
  ["", "Platform default"],
  ["claude-opus-4-8", "Claude Opus 4.8 — most capable Opus"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 — balanced (default)"],
  ["claude-haiku-4-5", "Claude Haiku 4.5 — fastest / cheapest"],
  ["claude-fable-5", "Claude Fable 5 — most powerful"],
];

// Common Bedrock regions + Claude model/inference-profile ids. Datalist
// SUGGESTIONS only (free text allowed) — what an AWS account actually has
// enabled varies; the config is validated against Bedrock on save anyway.
const BEDROCK_REGIONS = [
  "us-east-1", "us-east-2", "us-west-2", "ca-central-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-south-1", "sa-east-1",
];
const BEDROCK_MODEL_SUGGESTIONS = [
  "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-opus-4-5-20251101-v1:0",
];

// General-tab card: the organisation's AI/LLM provider. `llm` is the masked
// status from GET /v1/organizations/:id/anthropic-config (never raw secrets).
// Three shapes: locked (read-only, centrally managed), org-configured
// (Anthropic key or the org's own AWS Bedrock account), or platform fallback.
function anthropicCard(llm) {
  const providerLabel = (p) => (p === "bedrock" ? "AWS Bedrock" : p === "anthropic" ? "Anthropic API" : "—");

  // LOCKED: the deployment pins the provider in .env — explain exactly what is
  // active (provider/model/region, no secrets) and render no form at all.
  if (llm && llm.locked) {
    const pin = llm.configured
      ? `AI features are <b>active</b> and pre-set to <b>${providerLabel(llm.provider)}</b> · model <span class="mono">${escapeHtml(llm.model || "")}</span>${llm.region ? ` · region <span class="mono">${escapeHtml(llm.region)}</span>` : ""}.`
      : `<span class="text-rose-600">The provider lock is on, but no platform provider is configured — contact your administrator.</span>`;
    return `
        <div class="rounded-lg border border-stone-200 bg-white p-5">
          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold text-stone-900">AI · LLM provider</div>
            <span class="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-stone-100 border border-stone-200 text-stone-600">🔒 centrally managed</span>
          </div>
          <div class="text-xs text-stone-500 mt-0.5 mb-3">The server operator has locked the AI provider for this deployment (<span class="mono">LLM_SETTINGS_LOCKED</span>), so it cannot be changed per organisation.</div>
          <div class="text-xs text-stone-700 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">${pin}</div>
          <div class="text-xs text-stone-400 mt-2">API keys and AWS credentials live in the server configuration and are never shown here.</div>
        </div>`;
  }

  const usingOrg = !!llm && llm.source === "org";
  const status = !llm
    ? `<span class="text-stone-400">checking…</span>`
    : usingOrg && llm.provider === "bedrock"
    ? `Using <b>your AWS Bedrock account</b> · access key <span class="mono">${escapeHtml(llm.hint || "")}</span> · region <span class="mono">${escapeHtml(llm.region || "")}</span> · model <span class="mono">${escapeHtml(llm.model || "")}</span>`
    : usingOrg
    ? `Using <b>your organisation's Anthropic key</b> <span class="mono">${escapeHtml(llm.hint || "")}</span>${llm.model ? ` · model <span class="mono">${escapeHtml(llm.model)}</span>` : ""}`
    : llm.configured
    ? `Using the <b>platform default</b> — ${providerLabel(llm.provider)}${llm.model ? ` · model <span class="mono">${escapeHtml(llm.model)}</span>` : ""}${llm.region ? ` · region <span class="mono">${escapeHtml(llm.region)}</span>` : ""}`
    : `<span class="text-rose-600">No AI provider configured — AI features are disabled until one is set.</span>`;

  // Pre-select the org's saved Anthropic model; surface a legacy/custom value not in the list.
  const curModel = usingOrg && llm.provider === "anthropic" && llm.model ? llm.model : "";
  const models = ANTHROPIC_MODELS.some(([v]) => v === curModel) ? ANTHROPIC_MODELS : [...ANTHROPIC_MODELS, [curModel, `${curModel} (custom)`]];
  const modelOpts = models
    .map(([v, label]) => `<option value="${escapeHtml(v)}"${v === curModel ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  const curProvider = usingOrg ? llm.provider : "platform";
  const provOpts = [
    ["platform", "Platform default (managed by the server operator)"],
    ["anthropic", "Anthropic API — your organisation's own key"],
    ["bedrock", "AWS Bedrock — your organisation's own AWS account"],
  ].map(([v, label]) => `<option value="${v}"${v === curProvider ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  const hidden = (p) => (p === curProvider ? "" : " hidden");
  return `
        <div class="rounded-lg border border-stone-200 bg-white p-5">
          <div class="text-sm font-semibold text-stone-900">AI · LLM provider</div>
          <div class="text-xs text-stone-500 mt-0.5 mb-3">Run this organisation's AI features (chat assistant, code &amp; connector generation) on — and billed to — your own account: an Anthropic API key, or your own AWS account via Bedrock. Credentials are stored encrypted; only a masked preview is ever shown.</div>
          <div class="text-xs text-stone-700 mb-3 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">Status: ${status}</div>
          <label class="block text-xs text-stone-500 mb-1">Provider</label>
          <select id="llm-provider" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3 bg-white">${provOpts}</select>

          <div id="llm-form-platform"${hidden("platform")}>
            <div class="text-xs text-stone-500 mb-3">Uses whatever the server operator configured in <span class="mono">.env</span>. Saving deletes any AI credentials stored for this organisation.</div>
          </div>

          <div id="llm-form-anthropic"${hidden("anthropic")}>
            <label class="block text-xs text-stone-500 mb-1">Anthropic API key</label>
            <input id="anthropic-key" type="password" autocomplete="off" placeholder="${usingOrg && llm.provider === "anthropic" ? "Enter a new key to replace the current one" : "sk-ant-…"}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2" />
            <label class="block text-xs text-stone-500 mb-1">Model <span class="text-stone-400">(optional)</span></label>
            <select id="anthropic-model" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3 bg-white">${modelOpts}</select>
          </div>

          <div id="llm-form-bedrock"${hidden("bedrock")}>
            <div class="text-xs text-stone-500 mb-3">Enter an IAM access key from <b>your AWS account</b>, ideally scoped to <span class="mono">bedrock:InvokeModel</span> only. Replacing the configuration requires re-entering all four fields.</div>
            <label class="block text-xs text-stone-500 mb-1">AWS region <span class="text-stone-400">(where Claude is enabled)</span></label>
            <input id="bedrock-region" list="bedrock-regions-list" autocomplete="off" placeholder="eu-north-1" value="${usingOrg && llm.provider === "bedrock" ? escapeHtml(llm.region || "") : ""}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2 mono" />
            <datalist id="bedrock-regions-list">${BEDROCK_REGIONS.map((r) => `<option value="${r}"></option>`).join("")}</datalist>
            <label class="block text-xs text-stone-500 mb-1">Bedrock model or inference-profile id</label>
            <input id="bedrock-model" list="bedrock-models-list" autocomplete="off" placeholder="eu.anthropic.claude-sonnet-4-5-20250929-v1:0" value="${usingOrg && llm.provider === "bedrock" ? escapeHtml(llm.model || "") : ""}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-1 mono" />
            <datalist id="bedrock-models-list">${BEDROCK_MODEL_SUGGESTIONS.map((m) => `<option value="${m}"></option>`).join("")}</datalist>
            <div class="text-[11px] text-stone-400 mb-2">Suggestions only — check which Claude models are enabled in your AWS console (Bedrock → Model access).</div>
            <label class="block text-xs text-stone-500 mb-1">AWS access key ID</label>
            <input id="bedrock-access-key-id" autocomplete="off" placeholder="AKIA…" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2 mono" />
            <label class="block text-xs text-stone-500 mb-1">AWS secret access key</label>
            <input id="bedrock-secret" type="password" autocomplete="off" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3" />
          </div>

          <div class="flex items-center gap-2">
            <button id="anthropic-save" class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40">Save</button>
          </div>
          <div id="anthropic-msg" class="text-xs mt-2"></div>
        </div>`;
}

// General-tab card: bring-your-own Qlerify account — the credential the server uses
// to fetch a model behind the Model page's "⤓ Reload from link". `q` is the masked
// status from GET /v1/organizations/:id/qlerify-config (never the raw key).
function qlerifyCard(q) {
  const usingOrg = !!q && q.source === "org";
  const status = !q
    ? `<span class="text-stone-400">checking…</span>`
    : usingOrg
    ? `Using <b>your organisation's key</b> <span class="mono">${escapeHtml(q.hint || "")}</span>`
    : q.configured
    ? `Using the <b>platform default</b> Qlerify credentials`
    : `<span class="text-rose-600">No Qlerify credentials configured — "Reload from link" is disabled until a key is set.</span>`;
  return `
        <div class="rounded-lg border border-stone-200 bg-white p-5">
          <div class="text-sm font-semibold text-stone-900">Modeller · Qlerify account</div>
          <div class="text-xs text-stone-500 mt-0.5 mb-3">Plug in your own Qlerify MCP API key so this organisation's model fetches (the Model page's "⤓ Reload from link") run against — and are scoped to — your own Qlerify account. The key is stored encrypted; only a masked preview is ever shown. Leave unset to use the platform default.</div>
          <div class="text-xs text-stone-700 mb-3 rounded-md bg-stone-50 border border-stone-200 px-3 py-2">Status: ${status}</div>
          <label class="block text-xs text-stone-500 mb-1">Qlerify API key</label>
          <input id="qlerify-key" type="password" autocomplete="off" placeholder="${usingOrg ? "Enter a new key to replace the current one" : "x-api-key…"}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-3" />
          <div class="flex items-center gap-2">
            <button id="qlerify-save" class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40">Save key</button>
            ${usingOrg ? `<button id="qlerify-clear" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Revert to platform default</button>` : ""}
          </div>
          <div id="qlerify-msg" class="text-xs mt-2"></div>
        </div>`;
}

function adminTabContent(tab, a) {
  if (tab === "general") {
    const curOrg = (state.orgs || []).find((o) => o.id === state.me?.organizationId) || {};
    const orgName = curOrg.name || currentOrgName();
    const slug = curOrg.slug || "—";
    const isSystem = curOrg.slug === "system";
    const delOpen = !!a.deleteOrgOpen;
    const delBusy = !!a.deleteOrgBusy;
    const dangerInner = isSystem
      ? `<div class="text-xs text-stone-500">The system organisation cannot be deleted.</div>`
      : !delOpen
      ? `<button id="org-delete-open" class="px-4 py-2 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 font-medium">Delete this organisation</button>`
      : `<div class="rounded-md border border-rose-300 bg-white p-3 max-w-md">
           <div class="text-xs text-stone-700 mb-2">This permanently deletes <b>${escapeHtml(orgName)}</b> and every workflow, model, dataset, member, and audit record it owns. Type <span class="mono font-semibold">${escapeHtml(orgName)}</span> below to confirm.</div>
           <input id="org-delete-confirm" autocomplete="off" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm mb-2" placeholder="${escapeHtml(orgName)}" />
           <div class="flex items-center gap-2">
             <button id="org-delete-cancel" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
             <button id="org-delete-go" disabled class="px-4 py-2 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed">${delBusy ? "Deleting…" : "Delete permanently"}</button>
           </div>
           <div id="org-delete-err" class="text-xs text-rose-600 mt-2"></div>
         </div>`;
    return `
      <div class="max-w-2xl space-y-6">
        <div class="rounded-lg border border-stone-200 bg-white p-5">
          <div class="text-sm font-semibold text-stone-900">Organisation name</div>
          <div class="text-xs text-stone-500 mt-0.5 mb-3">The display name shown across the console. The URL handle (slug <span class="mono">${escapeHtml(slug)}</span>) stays the same.</div>
          <div class="flex items-end gap-2">
            <input id="org-name-input" value="${escapeHtml(orgName)}" ${isSystem ? "disabled" : ""} class="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-50 disabled:text-stone-400" />
            <button id="org-name-save" ${isSystem ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40">Save</button>
          </div>
          <div id="org-name-msg" class="text-xs mt-2"></div>
          ${isSystem ? `<div class="text-xs text-stone-400 mt-1">The system organisation can't be renamed.</div>` : ""}
        </div>
        ${anthropicCard(a.anthropic)}
        ${qlerifyCard(a.qlerify)}
        <div class="rounded-lg border border-rose-300 bg-rose-50/40 p-5">
          <div class="text-sm font-semibold text-rose-800">Danger zone</div>
          <div class="text-xs text-rose-700 mt-0.5 mb-3">Deleting this organisation permanently removes all of its workflows, models, data, members, and history. This action cannot be undone.</div>
          ${dangerInner}
        </div>
      </div>`;
  }
  if (tab === "members") {
    const rows = (a.members || []).map((m) => `<tr>
      <td class="px-4 py-2 mono text-xs">${escapeHtml(m.subject)}</td>
      <td class="px-4 py-2 text-stone-600">${escapeHtml(m.primaryEmail || "—")}</td>
      <td class="px-4 py-2">${(m.roles || []).map(roleChip).join(" ") || '<span class="text-stone-400">—</span>'}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(m.status || "active")}</td>
      <td class="px-4 py-2 text-right"><button data-reset-pw="${escapeHtml(m.identityId)}" data-reset-subject="${escapeHtml(m.subject)}" class="text-xs px-2 py-1 rounded border border-stone-300 text-stone-700 hover:bg-stone-50">Reset password</button></td>
    </tr>`).join("");
    return `
      ${issuedCredentialBanner()}
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Username (IdP subject)</label><input id="m-subject" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="jane@corp" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Email</label><input id="m-email" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="optional" /></div>
        <button id="m-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add member</button>
      </div>
      <div class="text-xs text-stone-500 mb-3">Inviting a member issues a one-time temporary password (shown once below). With single sign-on not yet configured, share it over a secure channel — the member changes it on first sign-in.</div>
      ${tbl(["Username", "Email", "Roles", "Status", ""], rows, "No members.")}`;
  }
  if (tab === "roles") {
    const rows = (a.roles || []).map((r) => `<tr>
      <td class="px-4 py-2 mono text-xs">${escapeHtml(r.principalId)}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(r.principalType)}</td>
      <td class="px-4 py-2">${roleChip(r.roleKey)}</td>
      <td class="px-4 py-2 text-stone-600">${escapeHtml(r.scopeType)}: <span class="mono text-xs">${escapeHtml(String(r.scopeId).slice(0, 12))}</span></td>
    </tr>`).join("");
    const roleOpts = ["owner", "editor", "viewer", "deployer", "org_admin"].map((k) => `<option>${k}</option>`).join("");
    const scopeOpts = ["organization", "environment", "workspace", "workflow", "resource"].map((k) => `<option>${k}</option>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2 flex-wrap">
        <div><label class="block text-xs text-stone-500 mb-1">Principal id</label><input id="r-principal" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm mono" placeholder="identity id" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Role</label><select id="r-role" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm">${roleOpts}</select></div>
        <div><label class="block text-xs text-stone-500 mb-1">Scope</label><select id="r-scope" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm">${scopeOpts}</select></div>
        <div><label class="block text-xs text-stone-500 mb-1">Scope id</label><input id="r-scopeid" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm mono" placeholder="(org id for org scope)" /></div>
        <button id="r-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Assign role</button>
      </div>
      ${tbl(["Principal", "Type", "Role", "Scope"], rows, "No role assignments.")}`;
  }
  if (tab === "markings") {
    const rows = (a.markings || []).map((m) => `<tr>
      <td class="px-4 py-2"><span class="text-[11px] px-1.5 py-px rounded bg-rose-100 text-rose-800">${escapeHtml(m.name)}</span></td>
      <td class="px-4 py-2 text-stone-600">${escapeHtml(m.description || "—")}</td>
    </tr>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Marking</label><input id="mk-name" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="PII" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Description</label><input id="mk-desc" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="optional" /></div>
        <button id="mk-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add marking</button>
      </div>
      <div class="text-xs text-stone-500 mb-3">Markings are a mandatory access gate (MAC): a caller must hold every marking on a resource to access it, regardless of role.</div>
      ${tbl(["Marking", "Description"], rows, "No markings.")}`;
  }
  if (tab === "environments") {
    const rows = (a.environments || []).map((e) => `<tr>
      <td class="px-4 py-2 font-medium">${escapeHtml(e.name)}</td>
      <td class="px-4 py-2 text-stone-600">${escapeHtml(e.region || "local")}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(e.lifecycleState || "active")}</td>
    </tr>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Environment</label><input id="e-name" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="staging" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Region</label><input id="e-region" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="local" /></div>
        <button id="e-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add environment</button>
      </div>
      ${tbl(["Environment", "Region", "Lifecycle"], rows, "No environments.")}`;
  }
  if (tab === "workspaces") {
    const rows = (a.workspaces || []).map((w) => `<tr>
      <td class="px-4 py-2 font-medium">${escapeHtml(w.name)}</td>
      <td class="px-4 py-2 mono text-xs text-stone-500">${escapeHtml(String(w.environmentId).slice(0, 12))}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(w.lifecycleState || "active")}</td>
    </tr>`).join("");
    const envOpts = (a.environments || []).map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Workspace</label><input id="ws-name" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="Finance" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Environment</label><select id="ws-env" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm">${envOpts}</select></div>
        <button id="ws-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add workspace</button>
      </div>
      ${tbl(["Workspace", "Environment", "Lifecycle"], rows, "No workspaces.")}`;
  }
  if (tab === "workflows") {
    const rows = (a.workflows || []).map((pr) => `<tr>
      <td class="px-4 py-2 font-medium">${escapeHtml(pr.name)}</td>
      <td class="px-4 py-2 mono text-xs text-stone-500">${escapeHtml(String(pr.workspaceId).slice(0, 12))}</td>
      <td class="px-4 py-2 text-stone-500">${escapeHtml(pr.lifecycleState || "active")}</td>
      <td class="px-4 py-2 text-right"><button data-proj-del="${escapeHtml(pr.id)}" data-proj-name="${escapeHtml(pr.name)}" class="text-xs px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50">Delete</button></td>
    </tr>`).join("");
    const wsOpts = (a.workspaces || []).map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join("");
    const emptyMsg = "No workflows yet — create one and point it at a Qlerify model.";
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Workflow</label><input id="proj-name" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="Q3 Forecast" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Workspace</label><select id="proj-ws" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm">${wsOpts}</select></div>
        <button id="proj-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add workflow</button>
      </div>
      <div class="text-xs text-stone-500 mb-3">A new workflow starts empty — point it at your own Qlerify model (⚙ Set model) to give it data. Switch workflows from the breadcrumb at the top. Deleting a workflow permanently drops its tables, data, run history, and model versions.</div>
      ${tbl(["Workflow", "Workspace", "Lifecycle", ""], rows, emptyMsg)}`;
  }
  // audit
  const rows = (a.audit || []).map((ev) => `<tr>
    <td class="px-4 py-2 mono text-xs text-stone-500">${ev.seq}</td>
    <td class="px-4 py-2 font-medium">${escapeHtml(ev.action)}</td>
    <td class="px-4 py-2">${ev.decision ? `<span class="text-[11px] px-1.5 py-px rounded ${ev.decision === "allow" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}">${escapeHtml(ev.decision)}</span>` : "—"}</td>
    <td class="px-4 py-2 text-stone-600">${escapeHtml(ev.targetRef || "—")}</td>
    <td class="px-4 py-2 text-stone-500 text-xs">${escapeHtml(ev.reason || "")}</td>
    <td class="px-4 py-2 text-stone-400 text-xs mono">${escapeHtml((ev.occurredAt || "").toString().slice(0, 19).replace("T", " "))}</td>
  </tr>`).join("");
  return `
    <div class="mb-3 flex items-center gap-2">
      <button id="audit-verify" class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Verify chain integrity</button>
      <span id="audit-verify-result" class="text-sm text-stone-500"></span>
    </div>
    ${tbl(["#", "Action", "Decision", "Target", "Reason", "When"], rows, "No audit events.")}`;
}

function bindAdmin() {
  document.querySelectorAll("[data-admin-tab]").forEach((el) => el.addEventListener("click", () => {
    state.issuedCredential = null; // don't carry a one-time secret across tabs
    state.admin = { ...(state.admin || {}), tab: el.dataset.adminTab };
    render();
  }));
  const reload = () => loadAdmin();
  const act = async (fn) => { try { await fn(); await reload(); } catch (e) { alert(e.message); } };

  // Invite a member: the server issues a one-time temporary password (when the
  // identity has none yet). Capture it BEFORE reload so the banner can show it.
  document.getElementById("m-add")?.addEventListener("click", async () => {
    try {
      const subject = document.getElementById("m-subject").value.trim();
      if (!subject) throw new Error("Username is required");
      const email = document.getElementById("m-email").value.trim() || undefined;
      const r = await api("/v1/memberships", { method: "POST", body: JSON.stringify({ subject, email }) });
      state.issuedCredential = r.temporaryPassword ? { subject, password: r.temporaryPassword } : null;
      await reload();
    } catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-reset-pw]").forEach((el) => el.addEventListener("click", async () => {
    const identityId = el.dataset.resetPw;
    const subject = el.dataset.resetSubject || identityId;
    if (!confirm(`Reset the password for "${subject}"?\n\nTheir current password stops working immediately and a new temporary one is issued (shown once).`)) return;
    try {
      const r = await api(`/v1/members/${encodeURIComponent(identityId)}/reset-password`, { method: "POST", body: "{}" });
      state.issuedCredential = r.temporaryPassword ? { subject, password: r.temporaryPassword } : null;
      await reload();
    } catch (e) { alert(e.message); }
  }));
  document.getElementById("issued-copy")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.issuedCredential?.password || ""); } catch { /* clipboard blocked — the code stays selectable */ }
  });
  document.getElementById("issued-dismiss")?.addEventListener("click", () => { state.issuedCredential = null; render(); });
  document.getElementById("r-add")?.addEventListener("click", () => act(async () => {
    const principalId = document.getElementById("r-principal").value.trim();
    const scopeId = document.getElementById("r-scopeid").value.trim() || state.me?.organizationId;
    if (!principalId) throw new Error("Principal id is required");
    await api("/v1/role-assignments", { method: "POST", body: JSON.stringify({ principalId, roleKey: document.getElementById("r-role").value, scopeType: document.getElementById("r-scope").value, scopeId }) });
  }));
  document.getElementById("mk-add")?.addEventListener("click", () => act(async () => {
    const name = document.getElementById("mk-name").value.trim();
    if (!name) throw new Error("Marking name is required");
    await api("/v1/markings", { method: "POST", body: JSON.stringify({ name, description: document.getElementById("mk-desc").value.trim() || undefined }) });
  }));
  document.getElementById("e-add")?.addEventListener("click", () => act(async () => {
    const name = document.getElementById("e-name").value.trim();
    if (!name) throw new Error("Environment name is required");
    await api("/v1/environments", { method: "POST", body: JSON.stringify({ name, region: document.getElementById("e-region").value.trim() || "local" }) });
  }));
  document.getElementById("ws-add")?.addEventListener("click", () => act(async () => {
    const name = document.getElementById("ws-name").value.trim();
    const environmentId = document.getElementById("ws-env").value;
    if (!name) throw new Error("Workspace name is required");
    if (!environmentId) throw new Error("Pick an environment");
    await api("/v1/workspaces", { method: "POST", body: JSON.stringify({ name, environmentId }) });
  }));
  document.getElementById("proj-add")?.addEventListener("click", () => act(async () => {
    const name = document.getElementById("proj-name").value.trim();
    const workspaceId = document.getElementById("proj-ws").value;
    if (!name) throw new Error("Workflow name is required");
    if (!workspaceId) throw new Error("Pick a workspace");
    await api("/v1/workflows", { method: "POST", body: JSON.stringify({ name, workspaceId }) });
  }));
  document.querySelectorAll("[data-proj-del]").forEach((el) => el.addEventListener("click", () => act(async () => {
    const id = el.dataset.projDel;
    const name = el.dataset.projName || "this workflow";
    if (!confirm(`Delete workflow "${name}"?\n\nThis permanently drops its tables, all data, run history, and model versions. This cannot be undone.`)) return;
    await api(`/v1/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
    // If we just deleted the active workflow, fall back to the org's Default.
    if (AUTH.workflow() === id) AUTH.setWorkflow(null);
    // Refresh who-am-I so the breadcrumb picker drops the deleted workflow.
    try { state.me = await api("/v1/whoami"); } catch {}
  })));
  document.getElementById("audit-verify")?.addEventListener("click", async () => {
    const el = document.getElementById("audit-verify-result");
    el.textContent = "verifying…";
    try {
      const r = await api("/v1/audit/verify");
      el.innerHTML = r.ok ? `<span class="text-emerald-700">✓ intact — ${r.length} events, hash chain verified</span>` : `<span class="text-rose-700">✗ tampering detected at seq ${r.brokenAtSeq}</span>`;
    } catch (e) { el.textContent = e.message; }
  });

  // --- General tab: rename the org ------------------------------------------
  const curOrgName = () => (state.orgs || []).find((o) => o.id === state.me?.organizationId)?.name || currentOrgName();
  document.getElementById("org-name-save")?.addEventListener("click", async () => {
    const setMsg = (cls, text) => { const m = document.getElementById("org-name-msg"); if (m) { m.className = `text-xs mt-2 ${cls}`; m.textContent = text; } };
    const name = (document.getElementById("org-name-input")?.value || "").trim();
    if (!name) { setMsg("text-rose-600", "Name is required."); return; }
    if (name === curOrgName()) { setMsg("text-stone-400", "No change."); return; }
    setMsg("text-stone-400", "Saving…");
    try {
      const orgId = state.me?.organizationId;
      const updated = await api(`/v1/organizations/${encodeURIComponent(orgId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      // Refresh who-am-I so the top-bar org pill + switcher show the new name.
      try { state.me = await api("/v1/whoami"); state.orgs = state.me.organizations || []; } catch { /* keep the old context */ }
      render(); // repaint the admin header, the input, and the tenant bar
      setMsg("text-emerald-700", `Renamed to "${updated.name}".`);
    } catch (e) {
      setMsg("text-rose-600", e.message);
    }
  });

  // --- General tab: per-org AI/LLM provider ---------------------------------
  const anthropicMsg = (cls, html) => { const m = document.getElementById("anthropic-msg"); if (m) { m.className = `text-xs mt-2 ${cls}`; m.innerHTML = html; } };
  // Adaptive form: show only the selected provider's fields. (Absent entirely
  // when the deployment is locked — the card renders read-only, no controls.)
  document.getElementById("llm-provider")?.addEventListener("change", (e) => {
    const v = e.target.value;
    for (const p of ["platform", "anthropic", "bedrock"]) {
      document.getElementById(`llm-form-${p}`)?.toggleAttribute("hidden", p !== v);
    }
    anthropicMsg("", "");
  });
  document.getElementById("anthropic-save")?.addEventListener("click", async () => {
    const orgId = state.me?.organizationId;
    const provider = document.getElementById("llm-provider")?.value || "platform";
    const btn = document.getElementById("anthropic-save");
    const put = async (body, workingMsg, doneMsg) => {
      anthropicMsg("text-stone-400", workingMsg);
      if (btn) btn.disabled = true;
      try {
        const r = await api(`/v1/organizations/${encodeURIComponent(orgId)}/anthropic-config`, { method: "PUT", body: JSON.stringify(body) });
        await loadAdmin(); // repaints the card with the new masked status
        anthropicMsg("text-emerald-700", doneMsg(r));
      } catch (e) {
        if (btn) btn.disabled = false;
        anthropicMsg("text-rose-600", escapeHtml(e.message));
      }
    };
    if (provider === "platform") {
      if (!confirm("Revert to the platform default AI provider? Any AI credentials stored for your organisation will be deleted.")) return;
      await put({ clear: true }, "Reverting…", () => "Reverted to the platform default.");
    } else if (provider === "bedrock") {
      const region = (document.getElementById("bedrock-region")?.value || "").trim();
      const model = (document.getElementById("bedrock-model")?.value || "").trim();
      const accessKeyId = (document.getElementById("bedrock-access-key-id")?.value || "").trim();
      const secretAccessKey = (document.getElementById("bedrock-secret")?.value || "").trim();
      if (!region || !model || !accessKeyId || !secretAccessKey) {
        anthropicMsg("text-rose-600", "All Bedrock fields are required: region, model, access key ID, and secret access key.");
        return;
      }
      await put({ provider: "bedrock", region, model, accessKeyId, secretAccessKey }, "Validating with AWS Bedrock…",
        (r) => `Saved — now using your AWS Bedrock account <span class="mono">${escapeHtml(r.hint || "")}</span> · region <span class="mono">${escapeHtml(r.region || "")}</span> · model <span class="mono">${escapeHtml(r.model || "")}</span>.`);
    } else {
      const apiKey = (document.getElementById("anthropic-key")?.value || "").trim();
      const model = (document.getElementById("anthropic-model")?.value || "").trim();
      if (!apiKey) { anthropicMsg("text-rose-600", "Enter an API key."); return; }
      await put({ provider: "anthropic", apiKey, model: model || undefined }, "Validating key with Anthropic…",
        (r) => `Saved — now using your key <span class="mono">${escapeHtml(r.hint || "")}</span>${r.model ? ` · model <span class="mono">${escapeHtml(r.model)}</span>` : ""}.`);
    }
  });

  // --- General tab: per-org Qlerify key -------------------------------------
  const qlerifyMsg = (cls, html) => { const m = document.getElementById("qlerify-msg"); if (m) { m.className = `text-xs mt-2 ${cls}`; m.innerHTML = html; } };
  document.getElementById("qlerify-save")?.addEventListener("click", async () => {
    const apiKey = (document.getElementById("qlerify-key")?.value || "").trim();
    if (!apiKey) { qlerifyMsg("text-rose-600", "Enter an API key."); return; }
    qlerifyMsg("text-stone-400", "Validating key with Qlerify…");
    const btn = document.getElementById("qlerify-save"); if (btn) btn.disabled = true;
    try {
      const orgId = state.me?.organizationId;
      const r = await api(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`, { method: "PUT", body: JSON.stringify({ apiKey }) });
      await loadAdmin(); // repaints the card with the new masked status
      qlerifyMsg("text-emerald-700", `Saved — now using your key <span class="mono">${escapeHtml(r.hint || "")}</span>.`);
    } catch (e) {
      if (btn) btn.disabled = false;
      qlerifyMsg("text-rose-600", escapeHtml(e.message));
    }
  });
  document.getElementById("qlerify-clear")?.addEventListener("click", async () => {
    if (!confirm("Revert to the platform default Qlerify credentials? Your organisation's key will be removed.")) return;
    qlerifyMsg("text-stone-400", "Reverting…");
    try {
      const orgId = state.me?.organizationId;
      await api(`/v1/organizations/${encodeURIComponent(orgId)}/qlerify-config`, { method: "PUT", body: JSON.stringify({ clear: true }) });
      await loadAdmin();
      qlerifyMsg("text-emerald-700", "Reverted to the platform default credentials.");
    } catch (e) {
      qlerifyMsg("text-rose-600", escapeHtml(e.message));
    }
  });

  // --- General tab: delete the org (typed-name confirmation) -----------------
  document.getElementById("org-delete-open")?.addEventListener("click", () => {
    state.admin = { ...(state.admin || {}), deleteOrgOpen: true };
    render();
    setTimeout(() => document.getElementById("org-delete-confirm")?.focus(), 30);
  });
  document.getElementById("org-delete-cancel")?.addEventListener("click", () => {
    state.admin = { ...(state.admin || {}), deleteOrgOpen: false };
    render();
  });
  // Enable the irreversible button only when the typed name matches exactly.
  const delInput = document.getElementById("org-delete-confirm");
  const delGo = document.getElementById("org-delete-go");
  if (delInput && delGo) delInput.addEventListener("input", () => { delGo.disabled = delInput.value.trim() !== curOrgName(); });
  document.getElementById("org-delete-go")?.addEventListener("click", async () => {
    const errEl = document.getElementById("org-delete-err");
    const name = curOrgName();
    if ((document.getElementById("org-delete-confirm")?.value || "").trim() !== name) { if (errEl) errEl.textContent = "The name doesn't match."; return; }
    const orgId = state.me?.organizationId;
    state.admin = { ...(state.admin || {}), deleteOrgBusy: true };
    render();
    try {
      await api(`/v1/organizations/${encodeURIComponent(orgId)}`, { method: "DELETE" });
      // Switch away from the now-deleted org. Prefer another accessible org; if this
      // was the caller's only org there's nowhere to land, so sign out for a clean
      // re-auth rather than leaving a broken, org-less console.
      const remaining = (state.orgs || []).filter((o) => o.id !== orgId);
      state.me = null; state.orgs = []; state.admin = null;
      if (remaining.length) {
        AUTH.setOrg(remaining[0].id); // also clears the selected workflow
        state.modelMsg = { ok: true, text: `Organisation "${name}" was permanently deleted.` };
        navigate("#");
        setTimeout(() => { state.modelMsg = null; render(); }, 3500);
      } else {
        AUTH.clear();
        navigate("#login");
      }
    } catch (e) {
      state.admin = { ...(state.admin || {}), deleteOrgBusy: false };
      render();
      const e2 = document.getElementById("org-delete-err"); if (e2) e2.textContent = e.message;
    }
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

window.addEventListener("hashchange", onHashChange);
onHashChange().catch((e) => {
  root.innerHTML = `<div class="p-8 text-rose-700">Failed to load: ${e.message}</div>`;
});
