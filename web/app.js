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
import { expState, explorerView, bindExplorer, loadExplorer } from "./explorer.js";
import { modelView, loadModel, bindModelPage, registryBanner, modelToast } from "./model.js";
import { loadDashboard, loadFlow, loadFlowRows, loadOverview, loadMeta, genericColumns, attrText, dashboardView, bindDashboard } from "./dashboard.js";
import { loadDetail, detailView, bindDetail, mergedFlowView, flowRowsView, bindFlowRows } from "./detail.js";
import { loadConnectors, connectorsView, bindConnectors, disposeConnMonaco } from "./connectors.js";
import { loginView, bindLogin, changePasswordView, bindChangePassword } from "./auth.js";
import { loadAdmin, adminView, bindAdmin } from "./admin.js";

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

export function currentOrgName() {
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
export function qlerifyMark(cls) {
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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

window.addEventListener("hashchange", onHashChange);
onHashChange().catch((e) => {
  root.innerHTML = `<div class="p-8 text-rose-700">Failed to load: ${e.message}</div>`;
});
