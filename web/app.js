// Model-driven workflow demo UI — vanilla JS + Tailwind.
// Two views:
//   1. Dashboard:  table of cases with status + progress, "+ New case" button.
//   2. Detail:     per-case timeline + 7 BC panels, step-forward controls.
// Navigation is hash-based: "#" → dashboard, "#case/<id>" → detail.

const API = "";
const role = "Automation";
const root = document.getElementById("app");

const STATUS_TONE = {
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

const PHASE_TONE = {
  1: "border-stone-300",
  2: "border-amber-300",
  3: "border-rose-300",
  4: "border-sky-400",
  5: "border-emerald-400",
};

// Provenance (Part 2.1): where a fact came from. Colorblind-safe — the dashed
// border + 3-letter label distinguish modes without relying on hue alone.
const PROV_STYLE = {
  simulated: { label: "SIM",  chip: "bg-stone-100 text-stone-500 border border-dashed border-stone-300", title: "Simulated — synthesized locally, no real source connected" },
  recorded:  { label: "REC",  chip: "bg-sky-100 text-sky-700 border border-sky-200",                     title: "Recorded — captured from a real source, replayed offline" },
  live:      { label: "LIVE", chip: "bg-emerald-100 text-emerald-700 border border-emerald-200",         title: "Live — pulled from the connected source system" },
};
// Small provenance chip; unstamped/legacy facts read as simulated.
function provChip(mode) {
  const s = PROV_STYLE[mode] || PROV_STYLE.simulated;
  return `<span class="text-[9px] font-semibold px-1 py-px rounded ${s.chip}" title="${s.title}">${s.label}</span>`;
}

// Why a derived event fired (twin/derive.ts evidence rules). The `kind` is the
// scenario the data matched; `headline` phrases it for the event log. Null kind =
// a synthetic/simulator-stepped event, which carries no row-state evidence.
const EVIDENCE_KIND = {
  create: { label: "NEW ROW",   icon: "🆕", chip: "bg-emerald-100 text-emerald-700 border border-emerald-200", headline: "A new record was created with its required fields" },
  status: { label: "STATUS",    icon: "🔀", chip: "bg-violet-100 text-violet-700 border border-violet-200",     headline: "The record reached the status this event represents" },
  fields: { label: "NEW FIELD", icon: "✏️", chip: "bg-amber-100 text-amber-700 border border-amber-200",       headline: "This event introduced new field values on the record" },
  none:   { label: "SEQUENCE",  icon: "↪",  chip: "bg-stone-100 text-stone-500 border border-stone-200",       headline: "No row-state evidence — derived from sequence position" },
};
function evidenceChip(kind) {
  const e = EVIDENCE_KIND[kind];
  if (!e) return "";
  return `<span class="text-[9px] font-semibold px-1 py-px rounded ${e.chip}" title="${e.headline}">${e.label}</span>`;
}
// Faint diagonal hatch so simulated step cards read as "ghosted" vs solid real
// data (Tailwind has no hatch utility → inline style). "" for real modes.
function provHatch(mode) {
  return mode && mode !== "simulated"
    ? ""
    : "background-image:repeating-linear-gradient(45deg,rgba(120,113,108,0.06) 0 6px,transparent 6px 12px);";
}
// The configured mode for a bounded context (from /sim/meta), default simulated.
function provModeForBC(bc) {
  return state.meta.provenance?.byContext?.[bc]?.mode || "simulated";
}

const state = {
  // global
  view: "dashboard",     // "dashboard" | "detail" | "flow"
  cases: [],
  events: [],
  // Merged "all cases" flow (#flow): { counts: {ref→firings}, totalFirings, totalCases }
  // from /sim/flow-aggregate. The aggregate counterpart of a single case's log.
  flow: null,
  // Per-case flow (#rows): { cases: [{caseId, counts, firings, startAt, lastAt}], totalCases, cap }
  // startAt = first event's business date (case start); lastAt = most recent (business).
  // from /sim/flow-by-case. The merged flow split into one row per case.
  flowRows: null,
  // When the user clicks "show all" in the By-case banner, lift the server-side
  // 50-row cap on subsequent fetches (incl. the live poll). Sticky for the session.
  flowRowsShowAll: false,
  busy: false,
  // model-derived UI labels (filled from /sim/meta); defaults keep the UI sane
  // before the first fetch / if the endpoint is unavailable.
  meta: { title: "Workflow", rootAggregate: "Item", rootAggregatePlural: "Items", boundedContextCount: 0, aggregateCount: 0, eventCount: 0 },
  // detail view
  caseId: null,
  instance: null,   // per-run detail from /sim/instance
  prevInstance: null, // the instance snapshot before the last step (per-run diff)
  asOfPrev: null,   // when a step is selected: reconstruction JUST BEFORE its firings (as-of diff baseline)
  log: [],
  currentIndex: 0,
  // Refs whose ×N fired-count badge is expanded into one row per firing on the
  // timeline (push-down reflow). Persists across Step forward within a run;
  // cleared when a different case is loaded.
  expandedFirings: new Set(),
  // The one model event currently "split into branches": the shared spine runs
  // up to it, then the downstream fans out into one full branch per execution
  // (an FK-threaded instance tree). null = no split. Cleared on case switch.
  splitRef: null,
  // The timeline event the user selected to scrub the data view back in time:
  // the data view is reconstructed AS OF this event (the fold of the event log
  // up to & including it). It is the declared index into state.events (the same
  // index `data-step` encodes). null = no selection → the live, latest view.
  // Cleared on case switch and on any action that advances the live run.
  selectedStep: null,
  // per-BC adapter workbench (Part 2.3)
  bcList: null,       // /api/bc index
  bcData: null,       // /api/bc/:bc overview
  bcVerify: null,
  bcTest: null,
  bcRaw: null,
  bcCode: null,
  bcBusy: false,
  // chat
  chatOpen: false,
  chatMessages: [],      // Anthropic.MessageParam[] — the ACTIVE thread (advisor or connector)
  chatInput: "",
  chatBusy: false,
  chatInfo: null,        // { model, effort, apiKeyConfigured, ... }
  chatError: null,
  detailPanelMode: "chat",   // detail-view sidebar tab: "chat" (advisor) | "log" (event log)
  // The connector builder keeps one thread per (system, table) so switching
  // tables doesn't bleed history. state.chatMessages above is shared with the
  // dashboard/detail "Process advisor", so we stash the advisor thread while a
  // connector thread is active and restore it on leaving the explorer.
  connectorChats: {},        // key `${system}::${entity}` -> Anthropic.MessageParam[] (working copy)
  connectorChatKey: null,    // active connector key, or null when the advisor thread is active
  inConnectorMode: false,    // true when state.chatMessages holds a connector thread
  advisorChat: [],           // stashed advisor thread while a connector thread is active
  connectorChatsHydrated: new Set(), // keys whose server-persisted thread has been loaded this session
  // registry health — non-null message means the active workflow's model couldn't
  // be built into the event registry; surfaced as a top banner.
  registryError: null,
  // toast message (e.g. after setting a workflow's model)
  modelMsg: null,
  // organisation portfolio dashboard (#org) — the tier above the per-workflow
  // overview, spanning every workflow type in the org.
  org: null,            // /org/portfolio result
  orgBusy: false,
  orgMapOpen: false,    // attribute-mapping dialog open?
  orgMap: null,         // /org/mappings result (dialog data)
  orgMapBusy: false,
  orgMapErr: null,
  // create-workflow modal — the model is mandatory at creation (link or upload/paste)
  newWfUrl: "",
  newWfText: "",
  // model & versions (Model page — #model)
  modelNoContent: false,   // workflow has no model.json yet (content 404)
  modelStatus: null,    // GET /v1/workflow/model/status → { versions, current, total, currentVersion, sourceUrl }
  modelContent: null,   // GET /v1/workflow/model/content → raw current workflow.json
  modelBusy: false,     // a restore/reload is in flight
  // Global blocking loading overlay (dim scrim + spinner card). Ref-counted so
  // nested shows (e.g. a workflow switch whose loader opens its own overlay)
  // don't clear early; `active` is gated behind a short delay so quick ops don't
  // flash a scrim. Emitted by wrap() → survives every innerHTML rebuild.
  overlay: { count: 0, active: false, label: "", timer: null },
};

// --- Tenant auth/session (localStorage-backed) ------------------------------
// Every request must authenticate: with no token the server replies 401 and the
// api() wrapper redirects to the login screen (there is no header-less demo). A
// token (from /v1/auth/login) is sent as a bearer; the chosen org is sent as
// X-Org-Id (which only SELECTS among the identity's orgs — the server derives the
// canonical org_id).
const AUTH = {
  token: () => localStorage.getItem("ql.token") || "",
  org: () => localStorage.getItem("ql.org") || "",
  workflow: () => localStorage.getItem("ql.workflow") || "",
  setSession: (token) => localStorage.setItem("ql.token", token || ""),
  // Switching org invalidates the selected workflow — clear it so the new org
  // resolves its own default workflow (or the empty-org state) until one is picked.
  setOrg: (orgId) => { if (orgId) localStorage.setItem("ql.org", orgId); else localStorage.removeItem("ql.org"); localStorage.removeItem("ql.workflow"); },
  setWorkflow: (id) => { if (id) localStorage.setItem("ql.workflow", id); else localStorage.removeItem("ql.workflow"); },
  clear: () => { localStorage.removeItem("ql.token"); localStorage.removeItem("ql.org"); localStorage.removeItem("ql.workflow"); },
};

async function api(path, opts = {}) {
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

// ---------------------------------------------------------------------------
// Chat panel
// ---------------------------------------------------------------------------

async function loadChatInfo() {
  try {
    state.chatInfo = await api("/chat/info");
  } catch (e) {
    state.chatInfo = { apiKeyConfigured: false, error: e.message };
  }
}

function toggleChat() {
  state.chatOpen = !state.chatOpen;
  if (state.chatOpen && !state.chatInfo) loadChatInfo().then(render);
  render();
  if (state.chatOpen) setTimeout(() => document.getElementById("chat-input")?.focus(), 30);
}

async function sendChat() {
  const text = state.chatInput.trim();
  if (!text || state.chatBusy) return;

  // When the user is on a detail page, the URL holds which case they're
  // looking at — but the assistant never sees the URL. Inject a context
  // block so phrases like "this case" or "the next step" resolve correctly.
  let content;
  if (state.view === "detail" && state.caseId) {
    const cur = state.cases.find((d) => d.id === state.caseId);
    const desc = cur ? `status ${cur.status ?? "—"}` : "(unknown)";
    content = [
      { type: "text", text: `[Context: viewing case ${state.caseId} — ${desc}. When the user says "this case", "it", or refers to a step without naming a case, they mean this one.]` },
      { type: "text", text },
    ];
  } else if (state.view === "bcs" && state.exp && state.exp.system) {
    const e = state.exp;
    const kind = expKindOf(e, e.entity) === "valueObject" ? "value object" : "entity";
    const conns = (e.adapters || []).map((a) => `${a.id} (${a.kind}/${a.mode}→${a.targetEntity})`).join(", ") || "none";
    // Recent update notes for the connector targeting the selected table — the
    // same History-tab log — so the assistant is aware of prior work without a
    // tool call (get_connector_history gives the full log on demand).
    const sel = (e.adapters || []).find((a) => a.targetEntity === e.entity);
    const recent = (sel?.doc?.notes || []).slice(-3).map((n) => `${n.kind}: ${n.text}`).join("; ");
    const hist = recent ? ` Recent activity on this table's connector — ${recent}. Call get_connector_history for the full log.` : "";
    const ctx = `[Context: in the Systems explorer. System (bounded context): ${e.system}. Selected table: ${e.entity || "(none)"} — a model ${kind}. Existing connectors/adapters on this system: ${conns}.${hist} When the user says "this table", "this", "it", or "fill this", they mean the selected table — build or repair a connector that populates it, following the Connector Builder loop. Confirm before create/build/ingest.]`;
    content = [{ type: "text", text: ctx }, { type: "text", text }];
  } else {
    content = text;
  }
  state.chatMessages.push({ role: "user", content });
  state.chatInput = "";
  state.chatBusy = true;
  state.chatError = null;
  render();
  scrollChatToBottom();

  try {
    const resp = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ messages: state.chatMessages }),
    });
    state.chatMessages = resp.messages;
    // After an assistant turn the dashboard / current view may be stale (write tools).
    if (state.view === "dashboard") await loadDashboard();
    else if (state.view === "detail") await loadDetail();
    else if (state.view === "bcs") { await refreshExplorerAfterChat(); persistConnectorChat(); }
  } catch (e) {
    state.chatError = e.message;
  } finally {
    state.chatBusy = false;
    render();
    scrollChatToBottom();
  }
}

function clearChat() {
  // Clears only the active thread (the selected table's connector thread in
  // builder mode, or the advisor thread otherwise) since state.chatMessages IS
  // that thread. In connector mode also drop the server-persisted copy so the
  // cleared thread doesn't come back on reload.
  if (state.inConnectorMode && state.connectorChatKey && state.exp?.system && state.exp?.entity) {
    state.connectorChats[state.connectorChatKey] = [];
    state.connectorChatsHydrated.add(state.connectorChatKey); // server now empty; don't re-hydrate
    api(`/api/bc/${encodeURIComponent(state.exp.system)}/connector-chat?target=${encodeURIComponent(state.exp.entity)}`, { method: "DELETE" }).catch(() => {});
  }
  state.chatMessages = [];
  state.chatError = null;
  render();
}

// --- Connector-builder threads: one per (system, table) ---------------------
// state.chatMessages is shared with the dashboard/detail advisor, so we model
// two stashes: per-(system,table) connector threads and a single advisor thread.
// activate/deactivate swap the live thread in/out; stashActiveChat always saves
// the LIVE state.chatMessages first (sendChat reassigns that array each turn, so
// the map ref can be stale between turns — re-stashing on every swap keeps it
// correct).
function connectorChatKey(system, entity) {
  return `${system || ""}::${entity || ""}`;
}

function stashActiveChat() {
  if (state.inConnectorMode) state.connectorChats[state.connectorChatKey] = state.chatMessages;
  else state.advisorChat = state.chatMessages;
}

// Make the connector thread for (system, entity) the active chat. No-op if it is
// already active. Stashes whatever thread is currently live first, then lazily
// hydrates from the server-persisted copy.
function activateConnectorChat(system, entity) {
  const nk = connectorChatKey(system, entity);
  if (state.inConnectorMode && state.connectorChatKey === nk) return;
  stashActiveChat();
  state.inConnectorMode = true;
  state.connectorChatKey = nk;
  state.chatMessages = state.connectorChats[nk] || [];
  state.chatError = null;
  hydrateConnectorChat(system, entity, nk);
}

// Load the server-persisted thread for a connector key the first time it becomes
// active this session. Adopts the server copy only when we have no local thread
// for it yet (never clobbers an in-progress conversation) and the key is still
// the active one when the response lands.
async function hydrateConnectorChat(system, entity, nk) {
  if (!system || !entity) return;
  if (state.connectorChatsHydrated.has(nk)) return;
  state.connectorChatsHydrated.add(nk);
  try {
    const d = await api(`/api/bc/${encodeURIComponent(system)}/connector-chat?target=${encodeURIComponent(entity)}`);
    const msgs = d.messages || [];
    const local = state.connectorChats[nk];
    if (msgs.length && (!local || local.length === 0)) {
      state.connectorChats[nk] = msgs;
      if (state.connectorChatKey === nk) state.chatMessages = msgs;
      render();
    }
  } catch (_err) {
    state.connectorChatsHydrated.delete(nk); // allow a retry on next activation
  }
}

// Persist the active connector thread server-side (fire-and-forget). Called after
// each connector-builder turn so the history survives a reload.
function persistConnectorChat() {
  if (!state.inConnectorMode || !state.connectorChatKey) return;
  const e = state.exp;
  if (!e || !e.system || !e.entity) return;
  state.connectorChatsHydrated.add(state.connectorChatKey); // we are now the source of truth
  api(`/api/bc/${encodeURIComponent(e.system)}/connector-chat`, {
    method: "PUT",
    body: JSON.stringify({ target: e.entity, messages: state.chatMessages }),
  }).catch(() => {});
}

// Leave connector-builder mode: save the active connector thread and restore the
// advisor thread. Called when navigating away from the explorer.
function deactivateConnectorChat() {
  if (!state.inConnectorMode) return;
  stashActiveChat();
  state.inConnectorMode = false;
  state.connectorChatKey = null;
  state.chatMessages = state.advisorChat || [];
  state.chatError = null;
}

function scrollChatToBottom() {
  setTimeout(() => {
    const el = document.getElementById("chat-scroll");
    if (el) el.scrollTop = el.scrollHeight;
  }, 30);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Display label for an entity/aggregate identifier. The raw identifier is the
// source of truth everywhere (model keys, $refs, gen_ table names, codegen, data
// keys); this is the single hook for prettifying the text the user reads. With
// no model-supplied overrides it passes the name through verbatim — nothing is
// hard-coded to any particular model.
function prettyEntity(name) {
  return name;
}

// Inline formatting: bold, italic, inline code. Operates on already-escaped HTML.
function renderInline(escaped) {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/`([^`]+?)`/g, '<code class="bg-stone-100 px-1 py-0.5 rounded text-[12px] mono">$1</code>');
}

// Render a markdown table block. Lines are pre-escaped raw lines.
function renderTable(lines) {
  // Lines: ["| h1 | h2 |", "|---|---|", "| r1 | r2 |", ...]
  const split = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const header = split(lines[0]);
  const rows = lines.slice(2).map(split);
  const thead = `<tr>${header.map((h) => `<th class="text-left font-semibold px-2 py-1 border-b border-stone-300 bg-stone-50">${renderInline(h)}</th>`).join("")}</tr>`;
  const tbody = rows.map((r) => `<tr>${r.map((c) => `<td class="px-2 py-1 border-b border-stone-100 align-top">${renderInline(c)}</td>`).join("")}</tr>`).join("");
  return `<div class="overflow-x-auto my-2"><table class="text-[12px] w-full border-collapse"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
}

function renderTextContent(text) {
  const lines = escapeHtml(text).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines between blocks
    if (line.trim() === "") { i++; continue; }
    // Table: line starts with | and the next line is a separator (|---|---|)
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|?\s*$/.test(lines[i + 1])) {
      const tableLines = [line];
      i++;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      blocks.push(renderTable(tableLines));
      continue;
    }
    // Horizontal rule
    if (/^---+\s*$/.test(line)) { blocks.push('<hr class="my-2 border-stone-200" />'); i++; continue; }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length;
      const cls = lvl <= 2 ? "text-sm font-semibold mt-2 mb-1" : "text-[13px] font-semibold mt-2 mb-1 text-stone-700";
      blocks.push(`<div class="${cls}">${renderInline(h[2])}</div>`);
      i++;
      continue;
    }
    // Unordered list (consecutive lines starting with - or *)
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(`<ul class="list-disc ml-5 my-1 space-y-0.5">${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(`<ol class="list-decimal ml-5 my-1 space-y-0.5">${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`);
      continue;
    }
    // Paragraph — collect consecutive non-empty, non-special lines
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*\|/.test(lines[i]) && !/^---+\s*$/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(`<p class="my-1">${renderInline(paraLines.join("<br>"))}</p>`);
  }
  return blocks.join("");
}

function chatMessageHtml(m) {
  if (m.role === "user") {
    if (typeof m.content === "string") {
      return `
        <div class="flex justify-end">
          <div class="max-w-[85%] bg-stone-900 text-white px-3 py-2 rounded-2xl rounded-tr-md text-sm">
            ${renderTextContent(m.content)}
          </div>
        </div>
      `;
    }
    // Array. Could be tool_result blocks (internal turn) or text blocks
    // (user message with a [Context: ...] prefix that we hide from the UI).
    const textBlocks = (m.content || []).filter((b) => b.type === "text" && !String(b.text).startsWith("[Context:"));
    if (textBlocks.length > 0) {
      return `
        <div class="flex justify-end">
          <div class="max-w-[85%] bg-stone-900 text-white px-3 py-2 rounded-2xl rounded-tr-md text-sm">
            ${textBlocks.map((b) => renderTextContent(b.text)).join("")}
          </div>
        </div>
      `;
    }
    const results = (m.content || []).filter((b) => b.type === "tool_result");
    if (results.length === 0) return "";
    return results.map((r) => {
      const text = typeof r.content === "string" ? r.content : (Array.isArray(r.content) ? r.content.map((c) => c.text || "").join("") : "");
      const tone = r.is_error ? "border-rose-200 bg-rose-50 text-rose-800" : "border-stone-200 bg-stone-50 text-stone-600";
      const trimmed = text.length > 220 ? text.slice(0, 220) + "…" : text;
      return `
        <details class="text-[11px] ${tone} border rounded px-2 py-1 my-1">
          <summary class="cursor-pointer select-none">${r.is_error ? "❌" : "↩"} tool result <span class="text-stone-400">(${text.length} chars)</span></summary>
          <pre class="mono text-[11px] whitespace-pre-wrap mt-1">${escapeHtml(trimmed)}</pre>
        </details>
      `;
    }).join("");
  }
  // assistant
  const blocks = (m.content || []).map((b) => {
    if (b.type === "text") {
      return `<div class="text-sm text-stone-800">${renderTextContent(b.text)}</div>`;
    }
    if (b.type === "tool_use") {
      const args = JSON.stringify(b.input, null, 2);
      const argsPreview = args.length > 120 ? args.slice(0, 120) + "…" : args;
      const WRITE_TOOLS = ["next_step", "create_case", "regenerate_adapter_body", "reset_adapter", "create_connector", "build_connector", "ingest_connector", "remove_connector"];
      const writeTone = WRITE_TOOLS.includes(b.name) ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-stone-50";
      return `
        <details class="text-[11px] ${writeTone} border rounded px-2 py-1 my-1">
          <summary class="cursor-pointer select-none text-stone-700">🔧 <b>${escapeHtml(b.name)}</b> <span class="text-stone-400 mono">${escapeHtml(argsPreview)}</span></summary>
          <pre class="mono text-[11px] whitespace-pre-wrap mt-1 text-stone-600">${escapeHtml(args)}</pre>
        </details>
      `;
    }
    if (b.type === "thinking") {
      // Adaptive thinking is enabled; show a tiny indicator that the model thought, but don't dump the text.
      return `<div class="text-[10px] text-stone-400 italic my-0.5">thinking…</div>`;
    }
    return "";
  }).join("");
  return `
    <div class="flex justify-start">
      <div class="max-w-[92%]">
        <div class="text-[10px] uppercase tracking-widest text-stone-400 mb-0.5">assistant</div>
        ${blocks}
      </div>
    </div>
  `;
}

// The assistant follows a "confirm before any write" policy (see the connector
// tool descriptions and system-prompt) — it asks "Shall I proceed?" / "Confirm?"
// and stops, waiting for an explicit yes. When its most recent message is one of
// these pauses, we offer one-click Yes/No replies instead of making the user type.
const CONFIRM_RE = /\b(shall i (?:proceed|continue|go ahead)|should i (?:proceed|continue|go ahead)|do you want me to (?:proceed|continue|go ahead)|want me to (?:proceed|go ahead)|ready to proceed|proceed\?|confirm\?|go ahead\?)/i;

function lastAssistantAsksConfirmation() {
  const msgs = state.chatMessages;
  if (!msgs || msgs.length === 0) return false;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant") return false;
  const blocks = Array.isArray(last.content) ? last.content : [];
  // A pending tool_use means the agent loop is still mid-flight (or already
  // proceeded) — only offer the buttons when the turn ended on the question.
  if (blocks.some((b) => b.type === "tool_use")) return false;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  return CONFIRM_RE.test(text);
}

// Quick-reply chips shown under a "Shall I proceed?" pause. The label is what the
// user sees; data-quick-reply is the exact text sent as their answer (clear,
// explicit phrasing the model reads as a yes/no per the confirmation policy).
function confirmQuickReplies() {
  return `
    <div class="flex flex-wrap gap-2 pt-1">
      <button data-quick-reply="Yes, proceed." class="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 font-medium">Yes, proceed</button>
      <button data-quick-reply="No, don't proceed." class="px-3 py-1.5 text-xs rounded-md bg-white border border-stone-300 text-stone-700 hover:bg-stone-100 font-medium">No</button>
    </div>`;
}

function chatPanel() {
  if (!state.chatOpen) return "";
  // In the Systems explorer the panel is the SINGLE connector sidebar with two
  // tabs — Chat (the builder conversation) and History (the connector's update
  // notes). Other views keep the plain single-mode advisor panel.
  const builder = state.view === "bcs";
  const detail = state.view === "detail";
  const mode = builder ? (state.exp?.panelMode || "history")
             : detail  ? (state.detailPanelMode || "chat")
             : "chat";
  const info = state.chatInfo;
  const apiOk = info?.apiKeyConfigured;
  const apiBadge = info
    ? (apiOk
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">${info.model} · ${info.effort}</span>`
        : `<span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-800">no api key</span>`)
    : `<span class="text-[10px] text-stone-400">loading…</span>`;

  const tabBtn = (m, label) => `<button id="cpanel-tab-${m}" class="flex-1 text-xs py-1 rounded ${mode === m ? "bg-white text-stone-900 shadow-sm font-medium" : "text-stone-500 hover:text-stone-700"}">${label}</button>`;
  const tabs = builder ? `
    <div class="flex gap-1 mt-2 bg-stone-100 rounded-md p-0.5">
      ${tabBtn("history", "History")}${tabBtn("chat", "Chat")}
    </div>`
    : detail ? `
    <div class="flex gap-1 mt-2 bg-stone-100 rounded-md p-0.5">
      ${tabBtn("chat", "Assistant")}${tabBtn("log", "Event log")}
    </div>` : "";

  const header = `
    <div class="px-4 py-3 border-b border-stone-200">
      <div class="flex items-center gap-2">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Assistant</div>
          <div class="text-sm text-stone-800 font-medium">${builder ? "Connector builder" : (detail && mode === "log") ? "Event log" : "Process advisor"}</div>
        </div>
        ${mode === "chat" ? apiBadge : ""}
        ${mode === "chat" ? `<button id="chat-clear" title="Clear conversation" class="text-stone-400 hover:text-stone-700 text-sm">↺</button>` : ""}
        <button id="chat-close" title="Close" class="text-stone-400 hover:text-stone-700 text-lg leading-none">×</button>
      </div>
      ${tabs}
    </div>`;

  const shell = (body) => `
    <aside class="fixed top-0 right-0 bottom-0 w-[420px] bg-white border-l border-stone-200 shadow-xl flex flex-col z-30">
      ${header}${body}
    </aside>`;

  if (builder && mode === "history") return shell(connectorHistoryBody(state.exp || {}));
  if (detail && mode === "log") return shell(eventLogBody());

  const messagesHtml = state.chatMessages.map(chatMessageHtml).join("");
  const empty = state.chatMessages.length === 0;
  const examples = state.view === "detail" ? [
    "Explain the next step in this workflow!",
    "Explain the last thing that was completed on this workflow.",
    "Why hasn't this case moved forward yet?",
    "Move this case forward one step.",
  ] : builder ? [
    "Fill this table from our DynamoDB users table",
    "Connect this to a REST API and pull the records",
    "Populate this from a Postgres query",
    "Show me the connector code",
  ] : [
    "How many cases haven't moved in 24h?",
    "Which case is closest to being delivered?",
    "Are any cases stuck at the same step?",
    "Create a new case.",
  ];

  return shell(`
      ${!apiOk && info ? `
        <div class="px-4 py-3 bg-amber-50 border-b border-amber-200 text-[12px] text-amber-900">
          <b>No AI provider configured.</b> Choose one in <b>Org Admin → AI · LLM provider</b> (an Anthropic API key, or AWS Bedrock with your own AWS credentials), or add <span class="mono">ANTHROPIC_API_KEY</span> to <span class="mono">.env</span> and restart the server.
        </div>
      ` : ""}

      <div id="chat-scroll" class="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        ${empty ? `
          <div class="text-stone-500 text-sm">
            ${builder
              ? `Describe any source — DynamoDB, a REST API, Postgres, a Google Sheet — and I'll write a connector to fill <b>${escapeHtml(state.exp?.entity || "this table")}</b>, test it, fix any errors, and populate it. I'll confirm before each change. Past activity for this connector is on the <b>History</b> tab.`
              : "Ask about cases, the workflow, or have me advance a step. I'll always confirm before changing anything."}
            <div class="mt-3 flex flex-col gap-1.5">
              ${examples.map((q) => `<button class="text-left text-[12px] text-stone-700 hover:bg-stone-100 rounded px-2 py-1 border border-stone-200" data-example="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("")}
            </div>
          </div>
        ` : messagesHtml}
        ${state.chatBusy ? `<div class="text-stone-500 text-xs italic">thinking…</div>` : ""}
        ${state.chatError ? `<div class="text-rose-700 text-xs">⚠ ${escapeHtml(state.chatError)}</div>` : ""}
        ${!empty && !state.chatBusy && lastAssistantAsksConfirmation() ? confirmQuickReplies() : ""}
      </div>

      <div class="border-t border-stone-200 p-3">
        <textarea id="chat-input" rows="2" class="w-full text-sm border border-stone-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400 focus:border-amber-400 resize-none" placeholder="Ask anything about cases or the workflow…">${escapeHtml(state.chatInput)}</textarea>
        <div class="flex items-center gap-2 mt-2">
          <div class="flex-1 text-[10px] text-stone-400">Enter to send · Shift+Enter for new line</div>
          <button id="chat-send" ${state.chatBusy || !state.chatInput.trim() ? "disabled" : ""} class="px-3 py-1.5 text-xs rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">Send →</button>
        </div>
      </div>`);
}

// The "Event log" tab of the detail-view assistant sidebar: every event this
// case has fired, oldest → newest (state.log is newest-first, so reverse it),
// reading top-down like the timeline left-to-right.
function eventLogBody() {
  const log = (state.log || []).slice().reverse();
  if (log.length === 0) {
    return `<div class="flex-1 overflow-y-auto px-4 py-6 text-sm text-stone-500">
      No events yet — press <b>Step forward</b> to advance this case through the workflow.
    </div>`;
  }
  const rows = log.map((e, i) => {
    // payload is JSON-serialized command args; pretty-print it, fall back to the
    // raw string if it isn't valid JSON (legacy rows).
    let payloadStr = "";
    try { payloadStr = JSON.stringify(JSON.parse(e.payload ?? "null"), null, 2); }
    catch { payloadStr = String(e.payload ?? ""); }
    const hasPayload = payloadStr && !["null", "{}", '""'].includes(payloadStr);
    const biz = e.businessAt ? new Date(e.businessAt).toLocaleDateString() : null;
    // "Why it fired": the derivation scenario (kind) gives the headline, the
    // persisted evidence reason gives the specifics. Absent for synthetic events.
    const km = EVIDENCE_KIND[e.evidenceKind];
    const why = km
      ? `<div class="text-[11px] mb-2 rounded border border-stone-200 bg-white px-2 py-1.5">
           <div class="text-stone-700"><span class="mr-1">${km.icon}</span><b>Why it fired:</b> ${km.headline}</div>
           ${e.evidence ? `<div class="text-stone-500 mono text-[10px] mt-0.5">${escapeHtml(e.evidence)}</div>` : ""}
         </div>`
      : `<div class="text-[11px] text-stone-400 italic mb-2">No derivation evidence recorded — a simulator step, or derived before evidence was tracked (re-derive to populate).</div>`;
    return `
      <details class="border-b border-stone-100">
        <summary class="px-4 py-2.5 cursor-pointer select-none hover:bg-stone-50">
          <span class="text-[11px] tabular-nums text-stone-400 mr-1">${i + 1}</span>
          <span class="font-medium text-stone-900">${escapeHtml(e.eventName)}</span> ${provChip(e.provenance)} ${evidenceChip(e.evidenceKind)}
          <div class="text-xs text-stone-500 mt-0.5 ml-5">
            <span class="mono">${escapeHtml(e.boundedContext)}</span> · ${escapeHtml(e.role)} · ${new Date(e.occurredAt).toLocaleTimeString()}${biz ? ` · <span title="business date">${biz}</span>` : ""}
          </div>
        </summary>
        <div class="px-4 pb-3 pl-9">
          ${why}
          ${hasPayload
            ? `<pre class="mono text-[11px] whitespace-pre-wrap bg-stone-50 border border-stone-200 rounded p-2 text-stone-600">${escapeHtml(payloadStr)}</pre>`
            : `<div class="text-[11px] text-stone-400 italic">No payload</div>`}
          <div class="text-[10px] text-stone-400 mt-1 mono">${escapeHtml(e.aggregateRoot || "")} · ${escapeHtml(e.aggregateId || "")}</div>
        </div>
      </details>`;
  }).join("");
  return `<div class="flex-1 overflow-y-auto text-sm">${rows}</div>`;
}

function bindChat() {
  document.getElementById("chat-toggle")?.addEventListener("click", toggleChat);
  // Connector sidebar tabs (Systems explorer): flip the one panel between the
  // builder conversation and the connector's update-notes history.
  document.getElementById("cpanel-tab-chat")?.addEventListener("click", () => {
    if (state.view === "detail") state.detailPanelMode = "chat";
    else if (state.exp) state.exp.panelMode = "chat";
    render();
    setTimeout(() => document.getElementById("chat-input")?.focus(), 30);
  });
  document.getElementById("cpanel-tab-history")?.addEventListener("click", () => {
    if (state.exp) state.exp.panelMode = "history";
    render();
  });
  document.getElementById("cpanel-tab-log")?.addEventListener("click", () => {
    state.detailPanelMode = "log";
    render();
  });
  if (!state.chatOpen) return;
  const input = document.getElementById("chat-input");
  if (input) {
    input.addEventListener("input", (e) => { state.chatInput = e.target.value; document.getElementById("chat-send").disabled = state.chatBusy || !state.chatInput.trim(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
  }
  document.getElementById("chat-send")?.addEventListener("click", sendChat);
  document.getElementById("chat-close")?.addEventListener("click", toggleChat);
  document.getElementById("chat-clear")?.addEventListener("click", clearChat);
  document.querySelectorAll("[data-example]").forEach((el) => {
    el.addEventListener("click", () => {
      state.chatInput = el.dataset.example;
      render();
      setTimeout(() => sendChat(), 30);
    });
  });
  // Yes/No chips under a "Shall I proceed?" pause — send the canned answer as if
  // the user typed it (same path as sendChat, so view context is still injected).
  document.querySelectorAll("[data-quick-reply]").forEach((el) => {
    el.addEventListener("click", () => {
      state.chatInput = el.dataset.quickReply;
      render();
      setTimeout(() => sendChat(), 30);
    });
  });
}

// ---------------------------------------------------------------------------
// Model sync / version history
// ---------------------------------------------------------------------------

async function loadRegistryStatus() {
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
function modelReplaceInline() {
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

function bindWorkflowModel() {
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
function shortWorkflowUrl(url) {
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
function formatVersionDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Sidebar listing every stored version (newest first), each with a Restore
// action; the current version is highlighted instead.
function modelVersionSidebar() {
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
function modelView() {
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

async function loadModel() {
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
async function refreshModelPage() {
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
function rebuildSummaryText(rebuild) {
  if (!rebuild || !rebuild.connectors) return "";
  const ev = rebuild.derived ? rebuild.derived.events : 0;
  const failed = (rebuild.failures || []).length;
  return ` Re-ingested ${rebuild.inserted} row(s) from ${rebuild.connectors} connector(s), derived ${ev} event(s)${failed ? ` — ${failed} connector(s) failed to pull (re-pull from the explorer)` : ""}.`;
}

// Re-pull the latest model from the current version's stored link, then rebuild
// this workflow. Disabled in the UI when there is no link to pull from.
async function reloadWorkflowModel() {
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
async function restoreWorkflowVersion(versionId) {
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

function bindModelPage() {
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
function registryBanner() {
  if (!state.registryError) return "";
  return `
    <div class="bg-rose-600 text-white px-6 py-3 text-sm shadow">
      <div class="font-semibold">⚠ This workflow's model couldn't be loaded</div>
      <div class="mt-0.5 opacity-90">${escapeHtml(state.registryError)}</div>
      <div class="mt-1 text-xs opacity-80">The event registry couldn't be built from the current model. Open the <b>Model</b> tab and replace it with a valid Qlerify model.</div>
    </div>
  `;
}

function modelToast() {
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
function showOverlay(label) {
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
function hideOverlay() {
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

function navigate(hash) {
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

let dashboardTimer = null;

const WORKFLOW_SCOPED_VIEWS = new Set(["overview", "dashboard", "detail", "flow", "rows", "model", "bcs", "connectors"]);

async function ensureWorkflowSelected() {
  if (AUTH.workflow()) return;
  await ensureMe();
  const id = state.me?.workflowId;
  if (id) AUTH.setWorkflow(id);
}

async function onHashChange() {
  const r = parseHash();
  state.view = r.view;
  state.caseId = r.caseId ?? null;
  if (r.connSel) state.connSel = r.connSel; // deep-link: #connectors/<id> preselects it
  state.issuedCredential = null; // a one-time temp password never survives navigation
  // Leaving the Systems explorer hands the chat panel back to the Process
  // advisor (re-entering re-activates the table's connector thread).
  if (r.view !== "bcs") deactivateConnectorChat();

  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }

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
      dashboardTimer = setInterval(() => {
        if (state.view === "flow" && !state.busy) loadFlow().catch(() => {});
      }, 5000);
    } else if (r.view === "rows") {
      await loadFlowRows();
      // Poll every 5s so rows appear / fill in live as cases run.
      dashboardTimer = setInterval(() => {
        if (state.view === "rows" && !state.busy) loadFlowRows().catch(() => {});
      }, 5000);
    } else if (r.view === "overview") {
      await loadOverview();
    } else if (r.view === "org") {
      await loadOrg();
      // Poll every 5s so the portfolio reads as a live control tower.
      dashboardTimer = setInterval(() => {
        if (state.view === "org" && !state.orgBusy) loadOrg().catch(() => {});
      }, 5000);
    } else {
      await loadDashboard();
      // Poll every 5s so "last activity" pills age in front of the audience.
      dashboardTimer = setInterval(() => {
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
// Dashboard
// ---------------------------------------------------------------------------

async function loadDashboard() {
  const [cases, events] = await Promise.all([api("/sim/cases"), api("/sim/events"), loadRegistryStatus(), loadMeta()]);
  state.cases = cases;
  state.events = events;
  render();
}

// Merged "all cases" flow (#flow): the model's events plus per-event firing
// counts across every case (no single case loaded — state.flow.counts is the
// aggregate). Same model + meta the single-case flow uses, so the diagram is
// laid out identically; only the badges' meaning changes (all-cases totals).
async function loadFlow() {
  const [flow, events] = await Promise.all([api("/sim/flow-aggregate"), api("/sim/events"), loadRegistryStatus(), loadMeta()]);
  state.flow = flow;
  state.events = events;
  render();
}

// Per-case flow (#rows): the same model events plus each case's own ref→count
// map, so the merged flow can be split into one row per case. Shares the events +
// meta the merged flow uses, so columns line up identically.
async function loadFlowRows() {
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
async function loadOverview() {
  let totalCases = 0;
  try {
    const flow = await api("/sim/flow-aggregate");
    state.flow = flow;
    totalCases = flow.totalCases ?? 0;
  } catch { /* fall through to the List, which carries its own empty-state */ }
  if (totalCases > 0) {
    state.view = "flow";
    await loadFlow();
    dashboardTimer = setInterval(() => {
      if (state.view === "flow" && !state.busy) loadFlow().catch(() => {});
    }, 5000);
  } else {
    state.view = "dashboard";
    await loadDashboard();
    dashboardTimer = setInterval(() => {
      if (state.view === "dashboard" && !state.busy) loadDashboard().catch(() => {});
    }, 5000);
  }
}

// Model-derived UI labels — fetched once and reused; failures keep the defaults.
async function loadMeta() {
  try {
    const meta = await api("/sim/meta");
    state.meta = meta;
    document.title = `${meta.title} — Live`;
  } catch { /* keep defaults */ }
}

async function createCase() {
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

async function deleteCase(caseId, ev) {
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

function dashboardRow(d, cols) {
  const pct = Math.round((d.progress / d.total) * 100) || 0;
  // Columns derived from the root-aggregate row's own fields (model-generic).
  const cells = (cols || []).map((c) => `<td class="px-4 py-3 text-sm text-stone-700">${escapeHtml(String(d[c] ?? "—"))}</td>`).join("");
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
function genericColumns(rows) {
  const reserved = new Set(["id", "version", "createdAt", "updatedAt", "status", "progress", "total", "lastEvent", "dwellSeconds"]);
  const first = rows[0] || {};
  return Object.keys(first).filter((k) => !reserved.has(k)).slice(0, 4);
}

// Render a case attribute value for the narrow UI (the by-case gutter): scalars
// as-is, but a structured value — an object/array, or a JSON string holding one —
// collapsed to a readable scalar instead of dumping raw JSON. Some models store a
// mandatory attribute as a value object (or a JSON-encoded string), which would
// otherwise show as `{"...":...}` / `[object Object]` in the gutter.
function attrText(raw) {
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
function attrScalar(v) {
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

function dashboardView() {
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

function bindDashboard() {
  document.getElementById("btn-new-case")?.addEventListener("click", createCase);
  document.querySelectorAll("[data-go]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.go));
  });
  document.querySelectorAll("[data-delete]").forEach((el) => {
    el.addEventListener("click", (ev) => deleteCase(el.dataset.delete, ev));
  });
}

// ===========================================================================
// Organisation portfolio dashboard (#org) — the tier ABOVE the per-workflow
// overview. Spans every workflow TYPE in the org. Built from /org/portfolio
// (one cross-workflow aggregation over the event log). Capability-gating: panels
// that need a mapped attribute (e.g. a commitment date) render ready / partial /
// locked and link to the attribute-mapping dialog.
// ===========================================================================

async function loadOrg() {
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
async function orgGotoWorkflow(workflowId, hash) {
  if (workflowId && workflowId !== AUTH.workflow()) {
    AUTH.setWorkflow(workflowId);
    state.me = null;
    await ensureMe();
  }
  navigate(hash || "#");
}

// --- North-star band helpers ---
function orgTile(label, big, sub, opts = {}) {
  return `
    <div class="rounded-lg border border-stone-200 bg-white p-4">
      <div class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">${escapeHtml(label)}</div>
      <div class="mt-1 text-2xl font-semibold tabular-nums leading-none ${opts.tone || "text-stone-900"}">${escapeHtml(String(big))}</div>
      ${sub ? `<div class="mt-1 text-xs text-stone-500">${escapeHtml(sub)}</div>` : ""}
      ${opts.spark || ""}
    </div>`;
}
function orgSpark(series) {
  const max = Math.max(1, ...series.map((s) => s.count));
  const bars = series.map((s) => {
    const h = Math.max(2, Math.round((s.count / max) * 24));
    return `<div class="flex-1 bg-amber-300/80 rounded-sm" style="height:${h}px" title="${escapeHtml(s.week)}: ${s.count}"></div>`;
  }).join("");
  return `<div class="mt-2 flex items-end gap-0.5 h-6">${bars}</div>`;
}
// Per-workflow twin-trust chip — colour follows the provenance ladder.
function provTrustChip(tp) {
  const mode = tp.pct >= 50 ? "live" : tp.pct > 0 ? "recorded" : "simulated";
  const s = PROV_STYLE[mode] || PROV_STYLE.simulated;
  return `<span class="text-[9px] font-semibold px-1 py-px rounded ${s.chip}" title="${tp.real}/${tp.total} events from a real source">${tp.pct}% real</span>`;
}
function panelShell(eyebrow, title, body) {
  return `
    <section class="rounded-lg border border-stone-200 bg-white overflow-hidden">
      <div class="px-4 py-3 border-b border-stone-100">
        <div class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold">${escapeHtml(eyebrow)}</div>
        <div class="text-sm font-semibold text-stone-800">${escapeHtml(title)}</div>
      </div>
      <div class="p-4">${body}</div>
    </section>`;
}
function orgMiniStat(label, value, tone) {
  return `<div class="rounded-md border border-stone-200 bg-stone-50 p-3 text-center"><div class="text-xl font-semibold tabular-nums ${tone || "text-stone-900"}">${value}</div><div class="text-[10px] uppercase tracking-wide text-stone-500 mt-0.5">${escapeHtml(label)}</div></div>`;
}

// --- Timeliness panel: the capability-GATED demonstration. Renders locked /
// partial / ready off the commitDate capability's mapping coverage. ---
function orgTimelinessPanel(o) {
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
function orgCard(w) {
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

function orgExceptionRow(x) {
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
function orgBottleneckRow(b) {
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
function orgValueAtRiskPanel(o) {
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
function orgFreshnessPanel(o) {
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
function orgAiActivityPanel(o) {
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
function orgFilterLabel() {
  const id = AUTH.workflow();
  if (!id) return "";
  return (state.me?.workflows || []).find((w) => w.id === id)?.name || "workflow";
}

// "Focused: …" — not "Showing:". The focus narrows the per-workflow sections
// (cards, exceptions, bottlenecks, value-at-risk) while the headline KPIs,
// timeliness and freshness stay org-wide, so the label must not claim a full
// filter. The chip's ✕ / "View all" clear the focus (deselect the workflow).
function orgFilterChip() {
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

function orgView() {
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

function bindOrg() {
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
async function openOrgMap() {
  state.orgMapOpen = true; state.orgMapErr = null; state.orgMap = null;
  render();
  try { state.orgMap = await api("/org/mappings"); }
  catch (e) { state.orgMap = { error: e.message }; }
  render();
}

async function orgSaveMapping(workflowId, capabilityKey, field) {
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

function orgMapBody(m) {
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

function orgMapDialog() {
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

function bindOrgMap() {
  if (!state.orgMapOpen) return;
  document.querySelectorAll("[data-org-map-close]").forEach((el) => el.addEventListener("click", () => { state.orgMapOpen = false; state.orgMapErr = null; render(); }));
  document.querySelectorAll("[data-map-select]").forEach((el) => el.addEventListener("change", () => {
    orgSaveMapping(el.getAttribute("data-map-wf"), el.getAttribute("data-map-cap"), el.value);
  }));
}

// ===========================================================================
// Systems explorer (#bcs) — a three-pane data console:
//   Systems (bounded contexts) | Tables (entities) | Items (gen_ rows)
// + a Filters panel and a Configure Adapter sidebar (chat builder: later).
// Backed by /api/bc, /api/bc/:bc, /api/bc/:bc/raw — no new backend.
// ===========================================================================

function expState() {
  if (!state.exp) state.exp = { systems: [], system: null, entities: [], valueObjects: [], entity: null, items: [], adapters: [], health: null, filters: [], page: 0, panelMode: "history", sysCollapsed: false, tablesCollapsed: false, busy: false, tableMissing: false, rowEvents: {}, rowEventsBusy: false };
  return state.exp;
}

async function loadExplorer() {
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
async function loadHealth() {
  const e = expState();
  try { e.health = await api("/api/bc/health"); } catch (_err) { e.health = { gaps: 0, systems: [] }; }
  render();
}

async function selectExpSystem(name, targetEntity) {
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

async function selectExpEntity(name) {
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
async function fetchRowEvents(e) {
  if (!e.system || !e.entity) return {};
  try {
    const d = await api(`/api/bc/${encodeURIComponent(e.system)}/row-events?entity=${encodeURIComponent(e.entity)}&limit=2000`);
    return d.byRow || {};
  } catch (_err) { return {}; }
}

function expAdaptersForEntity(e) {
  return (e.adapters || []).filter((a) => a.targetEntity === e.entity);
}

async function expFetchRows() {
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

async function expClearRows() {
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
async function expReimportAll() {
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
function expKindOf(e, name) {
  if (!name) return null;
  if ((e.entities || []).some((t) => t.name === name)) return "entity";
  if ((e.valueObjects || []).some((t) => t.name === name)) return "valueObject";
  return null;
}

// Open the assistant docked on the right as the connector builder, scoped (via
// sendChat's context injection) to the selected system + table. Closes the
// Configure-Adapter sidebar first so the two right panels don't stack.
function openConnectorChat() {
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
async function refreshExplorerAfterChat() {
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

function applyExpFilters(items, filters) {
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

function explorerView() {
  const e = expState();
  return `
    <div class="flex-1 flex min-h-0 overflow-hidden bg-stone-50">
      ${expSystemsCol(e)}
      ${expTablesCol(e)}
      ${expMain(e)}
    </div>`;
}

// Dot + label per 4-state connection status, shown on every Tables-pane row.
const STATUS_DOT = {
  live: "bg-emerald-500",
  simulated: "bg-sky-500",
  wired_empty: "bg-white border-2 border-amber-400",
  no_adapter: "bg-white border-2 border-stone-300",
};
const STATUS_LABEL = {
  live: "Live data — connected to a live source",
  simulated: "Simulated / recorded data",
  wired_empty: "Connector configured, but no data pulled yet",
  no_adapter: "No connector — not connected to a source",
};

// One marker per table row: SHAPE encodes type (square = entity, diamond = value
// object), COLOR encodes the 4-state connection status (same scheme as before).
// The full type + state is spelled out in the hover tooltip.
function tableGlyph(kind, status) {
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
function expRowEntries(e) {
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

function expSystemsCol(e) {
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

function expTablesCol(e) {
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
const EVENT_PROV_DOT = { live: "bg-emerald-500", recorded: "bg-violet-500", simulated: "bg-sky-500" };
const EVENT_PROV_LABEL = { live: "Live", recorded: "Recorded", simulated: "Simulated" };

// One event chip: name + provenance dot + business time, with a hover title
// spelling out provenance, role, evidence, and time.
function eventChip(ev) {
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
function rowEventsCell(events, busy) {
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
const EXP_HIDDEN_COLS = new Set(["_provenance", "organization_id"]);

// Header styling per column state (see expColumns).
const EXP_COL_STYLE = {
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
function expColumns(e, entity) {
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

function expMain(e) {
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

function expFiltersPanel(e, cols) {
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
const NOTE_BADGE = {
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
function connectorSlug(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
}

// A connector's DISPLAY name. The id is an immutable persistence key (filename,
// journal key, registry id) minted ONCE from system+table; a re-point changes the
// target but deliberately freezes the id, so rendering the raw id reads as a stale
// "wrong table" name. Derive the name from the CURRENT target instead — but only
// for auto-minted ids (which carry the system slug as a prefix). A custom id is the
// user's chosen name and is left untouched. bcFallback covers callers (the sidebar
// card) whose object may not carry boundedContext but whose system is known.
function connectorName(c, bcFallback) {
  const bc = c.boundedContext || bcFallback || "";
  const id = c.id || "";
  return id.startsWith(connectorSlug(bc) + "-") ? connectorSlug(`${bc}-${c.targetEntity}`) : id;
}

// One connector card: name + shape, the doc summary, and the most recent update
// notes (newest first). doc rides along on the adapter from /api/bc/:bc. `bc` is
// the selected system, used to derive the live name when re-pointing renamed it.
function connectorCard(a, bc) {
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
function connectorHistoryBody(e) {
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
function initTooltips() {
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

function bindExplorer() {
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

// ---------------------------------------------------------------------------
// Detail view — model-generic relationship forest (genericDetailView)
// ---------------------------------------------------------------------------

async function loadDetail() {
  await loadMeta();
  // Per-run detail from the model-generic simulator.
  const [instance, events, cur] = await Promise.all([
    api("/sim/instance/" + encodeURIComponent(state.caseId)),
    api("/sim/events"),
    api("/sim/current-step?caseId=" + encodeURIComponent(state.caseId)),
    loadRegistryStatus(),
  ]);
  // Keep the pre-step instance so the detail view can mark what this step
  // changed. Only diff within the same run — switching runs starts clean.
  state.prevInstance = state.instance && state.instance.instanceId === instance.instanceId ? state.instance : null;
  // New run (not just a step within the same run) → collapse any expanded
  // fired-count badges and any active branch split so the next case starts clean.
  if (state.prevInstance === null) { state.expandedFirings = new Set(); state.splitRef = null; state.selectedStep = null; }
  state.instance = instance;
  state.events = events;
  // newest-first so lastEventInline() / businessByStep read the latest first
  // (the Event log tab reverses it back to chronological order).
  state.log = (instance.events || []).slice().reverse();
  state.currentIndex = cur.index;
  render();
}

async function doNext() {
  if (state.busy) return;
  state.selectedStep = null; // advancing the live run drops any as-of scrub
  state.busy = true; render();
  try {
    await api("/sim/next", {
      method: "POST",
      body: JSON.stringify({ caseId: state.caseId }),
    });
    await loadDetail();
  } catch (e) {
    alert(e.message);
  } finally {
    state.busy = false; render();
  }
}

async function doRunAll() {
  if (state.busy) return;
  state.selectedStep = null; // advancing the live run drops any as-of scrub
  state.busy = true; render();
  try {
    await api("/sim/run-all", {
      method: "POST",
      body: JSON.stringify({ caseId: state.caseId }),
    });
    await loadDetail();
  } catch (e) {
    alert(e.message);
  } finally {
    state.busy = false; render();
  }
}

async function doReset() {
  if (state.busy) return;
  if (!confirm("Reset this case and start over?")) return;
  state.busy = true; render();
  try {
    await api("/sim/reset", { method: "POST", body: JSON.stringify({ caseId: state.caseId }) });
    // case was deleted; go back to dashboard
    navigate("#");
  } finally {
    state.busy = false;
  }
}

function pill(text, status) {
  const tone = STATUS_TONE[status] || "bg-stone-100 text-stone-700";
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${tone}">${text}</span>`;
}

function shortId(id) {
  if (!id) return "—";
  return String(id).length > 14 ? String(id).slice(0, 8) + "…" : id;
}

// Build a per-step lookup of the businessAt timestamp recorded when each step fired.
function businessByStep() {
  const m = new Map(); // eventRef → ISO businessAt
  for (const entry of state.log) {
    if (entry.businessAt && !m.has(entry.eventRef)) m.set(entry.eventRef, entry.businessAt);
  }
  return m;
}

// The set of event refs that actually fired for the loaded instance (from the
// event log) — the gap-safe basis for "which steps are done". A derived run fires
// a non-contiguous subset, so step state must come from here, not a linear cursor.
function firedRefSet() {
  return new Set((state.log || []).map((entry) => entry.eventRef));
}

// How many times each event ref fired for the loaded instance — one log entry
// per firing, so an event replayed 10× (e.g. Project Created) maps to 10. Used
// to surface a "×N" multiplier on the card without adding a row.
function firedCountMap() {
  const counts = new Map();
  for (const entry of state.log || []) {
    counts.set(entry.eventRef, (counts.get(entry.eventRef) || 0) + 1);
  }
  return counts;
}

// All firings of each event ref for the loaded case, oldest → newest. state.log
// is newest-first, so prepending while iterating yields chronological order.
// Each entry keeps its own businessAt/payload/evidence, so an expanded card can
// give every firing its own row.
function firingsByRefMap() {
  const m = new Map(); // ref → [entry, …] oldest→newest
  for (const entry of state.log || []) {
    if (!m.has(entry.eventRef)) m.set(entry.eventRef, []);
    m.get(entry.eventRef).unshift(entry);
  }
  return m;
}

// Rendered height (px) of a card whose ×N badge is expanded into one row per
// firing. A header band (context/name/role + paddings) plus a slim row per
// firing; the lane reflow uses this to push lower lanes down. Always taller than
// a collapsed card (cardH 104) for any n ≥ 2.
const FIRING_ROW_H = 16;
function expandedCardHeight(n) {
  return 84 + n * FIRING_ROW_H + 26; // +26 leaves room for the "Split into branches" button
}

// High-salience corner badge: a filled emerald bubble overlapping the card's
// top-right corner, showing "×N" when an event fired more than once for this
// case. Rendered as a SIBLING of the cards (not a child) so it can overhang the
// card edge — the card itself clips children via overflow-hidden. (cx, cy) is the
// card's top-right corner in the flow container; the translate centres the bubble
// on that point. Hidden at 1 so the common single-firing case stays clean.
// Clickable: toggles per-firing expansion for `ref` (push-down reflow). When
// open it reads as pressed (amber ring) so the affordance to collapse is clear.
function firedCountBadge(ref, n, cx, cy, isOpen) {
  if (!n || n <= 1) return "";
  const ring = isOpen ? "ring-amber-400" : "ring-white";
  return `<div data-toggle-firings="${ref}" role="button" tabindex="0"
       class="absolute z-10 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-none shadow ring-2 ${ring} cursor-pointer hover:bg-emerald-600"
       style="left:${cx}px; top:${cy}px; transform:translate(-50%,-50%); min-width:20px; height:18px; padding:0 5px;"
       title="${isOpen ? "Click to collapse" : "Fired " + n + "× for this case — click to expand each firing into its own row"}">×${n}</div>`;
}

// Non-interactive twin of firedCountBadge for the aggregate views (merged flow,
// by-case rows): the SAME emerald "×N" corner bubble, hidden at n≤1, just without
// the click-to-expand affordance (there are no per-firing rows to expand there).
// Keeping one look means the badge reads identically across detail / merged / by
// case. (cx, cy) is the card's top-right corner; the translate centres it.
function flowCountBadge(n, cx, cy, title) {
  if (!n || n <= 1) return "";
  return `<div class="absolute z-10 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-none shadow ring-2 ring-white"
       style="left:${cx}px; top:${cy}px; transform:translate(-50%,-50%); min-width:20px; height:18px; padding:0 5px;"
       title="${escapeHtml(title || ("Fired " + n + "×"))}">×${n}</div>`;
}

// Readable business date. Rendered in UTC so it's stable regardless of the
// viewer's timezone (the businessAt value is a date carried in the event data).
function fmtBizDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function minutesBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  return Math.round((new Date(isoB).getTime() - new Date(isoA).getTime()) / 60_000);
}

// Compact elapsed-time label for the gap between two fired steps: minutes within
// the hour, hours within the day, days beyond (+30m, +2h, +9h, +14d) — so the
// timeline reads naturally whether a model's steps are minutes or weeks apart.
function fmtGap(min) {
  if (min < 60) return `+${min}m`;
  const h = Math.floor(min / 60), mm = min % 60;
  if (h < 24) return mm ? `+${h}h${mm}m` : `+${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `+${d}d${hh}h` : `+${d}d`;
}

// Human "how long ago" for a past ISO timestamp: "just now", "5m ago", "2h ago",
// "3d ago", "4mo ago", "1y ago". Pairs with the absolute date in the by-case
// gutter so a row reads "Jun 28, 14:05 · 5m ago".
function timeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// Small inline icons for the by-case copy-id control (currentColor so they tint
// with the button's text colour).
const iconCopy = `<svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const iconCheck = `<svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------------------
// Flow layout — turn the event DAG (each event's `predecessors`, the model's
// `follows` edges) into a 2-D placement:
//   • column = longest-path depth from a start event, so events that run in
//     parallel line up vertically in the same column;
//   • lane (row) = the longest path through the graph is the "main spine" and
//     stays on the top lane (0); every branch that forks off it drops to the
//     next free lane below and runs in its own row until it ends.
// A model with no `follows` edges (or a plain chain) collapses to one lane —
// i.e. the original single-row timeline, so nothing regresses for linear flows.
// ---------------------------------------------------------------------------
function computeFlowLayout(events) {
  const byRef = new Map();
  events.forEach((e, idx) => byRef.set(e.ref, { event: e, idx }));
  const preds = (ref) => (byRef.get(ref)?.event.predecessors || []).filter((p) => byRef.has(p));

  // No edges at all (linear model, or a server that predates `predecessors`) →
  // fall back to a single lane in declared order.
  if (!events.some((e) => preds(e.ref).length > 0)) {
    const place = new Map(events.map((e, i) => [e.ref, { col: i, lane: 0, idx: i }]));
    return { cols: events.length, lanes: 1, place, edges: [] };
  }

  const succ = new Map(events.map((e) => [e.ref, []]));
  for (const e of events) for (const p of preds(e.ref)) succ.get(p).push(e.ref);

  // col = longest path from a source (memoized); height = longest path to a sink.
  const colMemo = new Map();
  const col = (ref) => {
    if (colMemo.has(ref)) return colMemo.get(ref);
    const ps = preds(ref);
    const c = ps.length ? 1 + Math.max(...ps.map(col)) : 0;
    colMemo.set(ref, c);
    return c;
  };
  const hMemo = new Map();
  const height = (ref) => {
    if (hMemo.has(ref)) return hMemo.get(ref);
    const ss = succ.get(ref) || [];
    const h = ss.length ? 1 + Math.max(...ss.map(height)) : 0;
    hMemo.set(ref, h);
    return h;
  };
  events.forEach((e) => { col(e.ref); height(e.ref); });

  // Main spine: start at the source that begins the longest path, then walk
  // forward. At each fork, prefer a "shortcut" successor — an edge that skips one
  // or more columns (col advance > 1) — so the direct line stays on the top lane
  // and the skipped sub-process drops to a branch below it. (e.g. a model with a
  // direct "GPR Implemented → GPR Deployed" edge plus a longer "exemption" detour
  // keeps the direct edge straight on the spine and pushes the detour down.) With
  // no shortcut at the fork, fall back to the successor with the most depth
  // remaining, as before — so plain parallel branches still spine the longest path.
  const spine = new Set();
  const sources = events.filter((e) => preds(e.ref).length === 0).map((e) => e.ref);
  if (sources.length) {
    let cur = sources.reduce((a, b) => (height(b) > height(a) ? b : a));
    while (cur) {
      spine.add(cur);
      const ss = succ.get(cur) || [];
      if (!ss.length) break;
      const cc = col(cur);
      const shortcuts = ss.filter((s) => col(s) - cc > 1);
      cur = shortcuts.length
        ? shortcuts.reduce((a, b) => (col(b) > col(a) ? b : a))
        : ss.reduce((a, b) => (height(b) > height(a) ? b : a));
    }
  }

  // Lanes: spine on lane 0; every other event is grouped into a branch and each
  // branch laid out as a coherent horizontal band below the spine.
  //
  // A branch is a weakly-connected group of non-spine events (linked through
  // their non-spine predecessor edges). Branches are placed shortest-span first,
  // so a small sub-branch that forks off the spine and quickly merges back claims
  // the lane nearest the spine, while a longer branch that forked earlier is
  // pushed further down. That keeps the short branch's fork/merge connectors from
  // crossing over the long one — e.g. the GPR exemption detour sits on the row
  // right under the spine and the wider BR branch drops below it. Assigning a
  // whole branch one base lane (rather than node-by-node) also stops a branch
  // from zig-zagging when a later branch needs the inner lane.
  const lane = new Map();
  const occupied = new Set(); // "lane,col"
  for (const ref of spine) { lane.set(ref, 0); occupied.add(`0,${col(ref)}`); }

  const nonSpine = events.filter((e) => !spine.has(e.ref)).map((e) => e.ref);
  const adj = new Map(nonSpine.map((r) => [r, []]));
  for (const r of nonSpine) {
    for (const p of preds(r)) if (adj.has(p)) { adj.get(r).push(p); adj.get(p).push(r); }
  }
  const seen = new Set();
  const branches = [];
  for (const r of nonSpine) {
    if (seen.has(r)) continue;
    const members = [];
    const stack = [r];
    seen.add(r);
    while (stack.length) {
      const x = stack.pop();
      members.push(x);
      for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }
    const cs = members.map(col);
    branches.push({ members, minCol: Math.min(...cs), maxCol: Math.max(...cs) });
  }
  // Narrowest column span first → nearest the spine; ties to the later fork
  // (higher minCol), then declared order, so nesting reads inside-out.
  branches.sort((a, b) =>
    (a.maxCol - a.minCol) - (b.maxCol - b.minCol) ||
    b.minCol - a.minCol ||
    byRef.get(a.members[0]).idx - byRef.get(b.members[0]).idx);
  for (const br of branches) {
    // Lowest base lane free across every column the branch occupies, so a chain
    // branch lands on one clean row; an internal fork drops the extra node below.
    const cs = br.members.map(col);
    let base = 1;
    while (cs.some((c) => occupied.has(`${base},${c}`))) base++;
    const ordered = br.members.slice()
      .sort((a, b) => col(a) - col(b) || byRef.get(a).idx - byRef.get(b).idx);
    for (const ref of ordered) {
      const c = col(ref);
      let L = base;
      while (occupied.has(`${L},${c}`)) L++;
      lane.set(ref, L);
      occupied.add(`${L},${c}`);
    }
  }

  const place = new Map(events.map((e) => [e.ref, { col: col(e.ref), lane: lane.get(e.ref), idx: byRef.get(e.ref).idx }]));
  const cols = Math.max(...events.map((e) => col(e.ref))) + 1;
  const edges = [];
  for (const e of events) for (const p of preds(e.ref)) edges.push({ from: p, to: e.ref });

  // Route long edges around the cards they fly over. An edge that spans more
  // than one column (e.g. a fork that also jumps straight to a downstream merge,
  // so two branches run between the same pair of events) would otherwise be
  // drawn as a flat line straight through the cards sitting in the columns
  // between its ends. Give each such edge a "waypoint row" — the lowest lane
  // that is free in every column it crosses, adding a fresh row below when none
  // is — so it bows into its own row instead of overlapping those cards. Short
  // (adjacent-column) edges need no row and keep the original direct curve, so
  // linear flows produce no waypoints and the single-lane timeline is unchanged.
  const waypoints = new Map(); // `${from}->${to}` -> { lane, cols }
  let maxLane = events.reduce((m, e) => Math.max(m, lane.get(e.ref)), 0);
  const longEdges = edges
    .map((e) => ({ ...e, c0: col(e.from), c1: col(e.to) }))
    .filter((e) => e.c1 - e.c0 > 1)
    .sort((a, b) => (b.c1 - b.c0) - (a.c1 - a.c0)); // widest first → big arcs claim rows first
  for (const e of longEdges) {
    const mid = [];
    for (let c = e.c0 + 1; c < e.c1; c++) mid.push(c);
    // If both ends sit on the same lane and that lane is clear across every
    // column the edge spans, it can run dead straight along its own lane — no
    // need to bow it onto a routed row. This is what keeps a spine shortcut (e.g.
    // GPR Implemented → GPR Deployed) a straight horizontal line once the skipped
    // steps have dropped to lower lanes. Claim those cells so a later routed edge
    // can't overlap the straight run.
    const lf = lane.get(e.from), lt = lane.get(e.to);
    if (lf === lt && mid.every((c) => !occupied.has(`${lf},${c}`))) {
      mid.forEach((c) => occupied.add(`${lf},${c}`));
      continue;
    }
    let L = 1;
    while (!mid.every((c) => !occupied.has(`${L},${c}`))) L++;
    mid.forEach((c) => occupied.add(`${L},${c}`));
    maxLane = Math.max(maxLane, L);
    waypoints.set(`${e.from}->${e.to}`, { lane: L, cols: mid });
  }
  const lanes = maxLane + 1;
  return { cols, lanes, place, edges, waypoints };
}

// Connector path for one edge between two placed cards. Adjacent-column edges
// get the original smooth S-curve; an edge with a waypoint row (see
// computeFlowLayout) eases into that free row, runs flat across the columns it
// spans, then climbs to the target — so it never crosses the cards in between.
// Endpoints stay anchored to each card's header band (top + cardH/2) as before,
// even when a card is expanded tall; only the mid-run drops to the route row.
function flowEdgePath(a, b, wp, laneTop, laneHeight, geom) {
  const { cardW, cardH, colPitch } = geom;
  const sx = a.col * colPitch + cardW, sy = laneTop[a.lane] + cardH / 2;
  const ex = b.col * colPitch,         ey = laneTop[b.lane] + cardH / 2;
  if (!wp) {
    const dx = Math.max(24, (ex - sx) * 0.5);
    return `M${sx},${sy} C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`;
  }
  const ry = laneTop[wp.lane] + laneHeight[wp.lane] / 2; // centre of the waypoint row
  const x1 = sx + 28, x2 = ex - 28, k = 36;             // ease in / out within the column gutters
  return `M${sx},${sy} C${sx + k},${sy} ${x1 - k},${ry} ${x1},${ry} L${x2},${ry} C${x2 + k},${ry} ${ex - k},${ey} ${ex},${ey}`;
}

// Card + grid geometry (px). Cards are absolutely positioned so the connector
// SVG underneath can use exact coordinates; the column/row pitch leaves a gutter
// for the connectors between cards.
const FLOW = { cardW: 176, cardH: 104, colPitch: 224, rowPitch: 148 };
// Height of a waypoint-only row — one that carries a routed (skip) edge but no
// card. Kept short so a branch routed onto its own row reads clearly without
// wasting a full card-height of vertical space.
const ROUTE_ROW = 40;
// Denser geometry for the branched (split) view: many executions stack
// vertically, so rows are tight and the container scrolls.
const SPLIT_FLOW = { cardW: 184, cardH: 72, colPitch: 212, rowPitch: 86 };

// ---------------------------------------------------------------------------
// Branch split — turn the firings of a "split" model event into one full branch
// per execution. Each firing of the split event is a branch root; downstream
// firings thread onto it by FK ancestry (a payload field pointing back to a
// parent aggregate) or by sharing an aggregateId (same entity, a later step).
// The result is an instance forest: roots = executions, depth follows the real
// parent→child fan-out (Org → its Projects → their Workflows). See twin/
// correlate.ts for the server-side cousin of this FK heuristic.
// ---------------------------------------------------------------------------

// Parse a log entry's JSON payload defensively (returns {} on bad/empty data).
function parsePayload(s) {
  try { const o = JSON.parse(s ?? "null"); return o && typeof o === "object" ? o : {}; }
  catch { return {}; }
}

// Per-firing records for the loaded case, oldest→newest, each tagged with its
// model column (from the flow layout) and its cross-aggregate FK parent id (the
// payload field — other than its own id — whose value is another firing's
// aggregateId; *Id-suffixed fields win, mirroring the simulator's FK-by-name).
function caseFirings(layout) {
  const log = (state.log || []).slice().reverse(); // chronological
  const firings = log.map((e, i) => ({
    i,
    ref: e.eventRef,
    aggId: e.aggregateId || "",
    payload: parsePayload(e.payload),
    businessAt: e.businessAt,
    col: layout.place.get(e.eventRef)?.col ?? 0,
  }));
  const aggIds = new Set(firings.map((f) => f.aggId).filter(Boolean));
  for (const f of firings) {
    // ALL payload fields (other than own id) whose value is another firing's
    // aggregateId — the candidate FK parents. *Id-suffixed fields are listed
    // first, but which one actually becomes the parent is decided later by
    // column proximity in buildBranchForest. Collecting every candidate (not
    // just the first match) is what lets a firing carrying several FKs — e.g.
    // Team Member Added with both userId and projectId — latch onto the nearest
    // in-branch ancestor instead of whichever field happens to come first.
    const seen = new Set();
    f.parentAggs = [];
    const keys = Object.keys(f.payload)
      .filter((k) => k !== "id")
      .sort((a, b) => (b.endsWith("Id") ? 1 : 0) - (a.endsWith("Id") ? 1 : 0));
    for (const k of keys) {
      const v = f.payload[k];
      if (typeof v === "string" && v && v !== f.aggId && aggIds.has(v) && !seen.has(v)) {
        seen.add(v);
        f.parentAggs.push(v);
      }
    }
  }
  return firings;
}

// Forest of instance nodes rooted at the firings of `splitRef`. A firing in the
// split subtree (col ≥ the split column) attaches to: its own earlier firing on
// the same aggregate (same entity, prior step) if any; else the firing that owns
// its FK parent. Anything that resolves outside the subtree becomes a root.
function buildBranchForest(splitRef, layout, firings) {
  const splitCol = layout.place.get(splitRef)?.col ?? 0;
  const sub = firings.filter((f) => f.col >= splitCol);

  // Earliest firing per aggregate (for FK parent resolution) and same-aggregate
  // ordering (for the "later step on the same entity" chain).
  const firstByAgg = new Map();
  for (const f of firings) if (f.aggId && !firstByAgg.has(f.aggId)) firstByAgg.set(f.aggId, f);
  const byAgg = new Map();
  for (const f of sub) { if (!byAgg.has(f.aggId)) byAgg.set(f.aggId, []); byAgg.get(f.aggId).push(f); }
  for (const arr of byAgg.values()) arr.sort((a, b) => a.col - b.col || a.i - b.i);

  const nodeOf = new Map(sub.map((f) => [f, { f, children: [] }]));
  const roots = [];
  for (const f of sub) {
    const node = nodeOf.get(f);
    let parent = null;
    const chain = byAgg.get(f.aggId);
    const pos = chain.indexOf(f);
    if (pos > 0) parent = chain[pos - 1];                       // same entity, earlier step
    else {                                                      // cross-aggregate FK
      // Pick the closest ancestor inside the branch subtree: among every FK the
      // payload resolves to, keep the one with the highest column that is still
      // an earlier step (≥ split, < this firing's column). Preferring the
      // nearest in-branch parent stops a firing that also references an upstream
      // aggregate (e.g. Team Member Added → userId → User Registered, which sits
      // on the shared spine) from failing the subtree test and dropping to a
      // spurious root wired straight from the feeder event.
      for (const agg of f.parentAggs) {
        const p = firstByAgg.get(agg);
        if (!p || p === f || p.col < splitCol || p.col >= f.col) continue;
        if (!parent || p.col > parent.col) parent = p;
      }
    }
    if (parent && nodeOf.has(parent) && parent !== f) nodeOf.get(parent).children.push(node);
    else roots.push(node);
  }
  return { roots, splitCol };
}

// Assign a row to every node: leaves take successive rows, a parent centres on
// its children. Children are ordered by business time so branches read top-down
// in the order they happened. Returns the total row count.
function layoutForestRows(roots) {
  const byTime = (a, b) => (a.f.businessAt || 0) - (b.f.businessAt || 0);
  const sortKids = (n) => { n.children.sort(byTime); n.children.forEach(sortKids); };
  roots.sort(byTime);
  roots.forEach(sortKids);
  let r = 0;
  const assign = (n) => {
    if (!n.children.length) { n.row = r++; return; }
    n.children.forEach(assign);
    n.row = (n.children[0].row + n.children[n.children.length - 1].row) / 2;
  };
  roots.forEach(assign);
  return r;
}

function timeline() {
  const total = state.events.length;
  // Which events actually fired for THIS instance — from the event log, not a
  // contiguous step cursor. Derivation (and any non-linear run) fires a SUBSET of
  // the model's events (e.g. Account Confirmed fires but Account Logged In does
  // not, leaving a gap), so colour each box by whether its own event is in the
  // log — every fired step then reads as done regardless of gaps.
  const firedRefs = firedRefSet();
  const firedCounts = firedCountMap();
  const pct = total ? (firedRefs.size / total) * 100 : 0;
  const biz = businessByStep();
  let prevBizIso = null;

  const layout = computeFlowLayout(state.events);

  // Branch split takes over the whole flow area: the shared spine up to the
  // split event, then one full branch per execution downstream. Only honoured
  // while that event actually fired more than once for this case.
  if (state.splitRef && (firedCounts.get(state.splitRef) || 0) > 1) {
    return splitTimelineView(layout, state.splitRef, firedCounts);
  }

  const { cardW, cardH, colPitch, rowPitch } = FLOW;

  // Per-firing expansion (push-down reflow): a ×N badge the user clicked grows
  // its card downward into one row per firing, and the lanes below it shift down
  // to clear it. The reflow is driven by per-lane heights — a lane is as tall as
  // its tallest card, and each lane's Y is the cumulative height of those above
  // plus the usual gutter. With nothing expanded this is exactly the old uniform
  // rowPitch grid, so linear/collapsed flows are byte-identical.
  const expandedSet = state.expandedFirings || new Set();
  const firingsByRef = firingsByRefMap();
  const laneGap = rowPitch - cardH; // gutter between lanes in the original grid
  const isExpanded = (ref) => expandedSet.has(ref) && (firedCounts.get(ref) || 0) > 1;
  const cardHeightFor = (ref) => isExpanded(ref) ? expandedCardHeight(firedCounts.get(ref)) : cardH;

  // Lanes that hold no card (pure waypoint rows for routed skip edges) are short;
  // card lanes start at cardH and grow for any expanded card.
  const cardLanes = new Set(Array.from(layout.place.values(), (p) => p.lane));
  const laneHeight = Array.from({ length: layout.lanes }, (_, L) => cardLanes.has(L) ? cardH : ROUTE_ROW);
  for (const e of state.events) {
    const pos = layout.place.get(e.ref);
    if (pos) laneHeight[pos.lane] = Math.max(laneHeight[pos.lane], cardHeightFor(e.ref));
  }
  const laneTop = [];
  for (let L = 0, acc = 0; L < layout.lanes; L++) { laneTop[L] = acc; acc += laneHeight[L] + laneGap; }

  const W = (layout.cols - 1) * colPitch + cardW;
  const H = layout.lanes ? laneTop[layout.lanes - 1] + laneHeight[layout.lanes - 1] : cardH;

  // The most-recently-fired step (highest linear index that fired) — the cursor
  // we ring as "latest", replacing the old contiguous currentIndex-1.
  let lastFiredIndex = -1;
  state.events.forEach((e, i) => { if (firedRefs.has(e.ref)) lastFiredIndex = i; });

  // Iterate in declared (linear) order so `data-step`, the fired/current logic,
  // and the business-date gap accumulation all stay tied to the step sequence;
  // each card is then *positioned* by its lane/column placement.
  const cards = state.events.map((e, i) => {
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    const fired = firedRefs.has(e.ref);
    const isCurrent = i === lastFiredIndex;
    const isSelected = i === state.selectedStep;
    const phaseBorder = PHASE_TONE[e.phase] || "border-stone-300";
    // Selection (sky ring) is the active interaction → it wins over the amber
    // "latest fired" ring when a card is both.
    const ringClass = isSelected ? "ring-2 ring-sky-500" : isCurrent ? "ring-2 ring-amber-400" : "";
    // Every fired step is done → green. (No contiguous-frontier exclusion: a
    // derived run's fired set has gaps, and each fired box should read as done.)
    const isPast = fired;
    const open = isExpanded(e.ref);

    const bizIso = biz.get(e.ref);
    const bizLabel = fired ? fmtBizDate(bizIso) : null;
    const gapMin = fired && prevBizIso && bizIso ? minutesBetween(prevBizIso, bizIso) : null;
    if (fired && bizIso) prevBizIso = bizIso;

    // Highlight long gaps (≥10 days) in amber so the supplier-slip moment pops.
    const gapTone = gapMin != null && gapMin >= 10 * 1440 ? "text-amber-700 font-semibold" : "text-stone-500";

    // Each step's source mode = its bounded context's configured mode.
    const provMode = provModeForBC(e.boundedContext);

    // Expanded: one row per firing (chronological), each with its own business
    // date and the gap since the previous firing of THIS event. Collapsed: the
    // original single-date footer.
    let footer = "";
    if (open) {
      let prevIso = null;
      const rows = (firingsByRef.get(e.ref) || []).map((f, k) => {
        const d = fmtBizDate(f.businessAt) ?? "—";
        const g = prevIso && f.businessAt ? minutesBetween(prevIso, f.businessAt) : null;
        if (f.businessAt) prevIso = f.businessAt;
        const gt = g != null && g >= 10 * 1440 ? "text-amber-700 font-semibold" : "text-stone-500";
        return `<div class="flex items-baseline justify-between gap-1 leading-none py-0.5">
            <span class="text-stone-700"><span class="text-stone-400 tabular-nums mr-1">${k + 1}.</span><span class="mono font-medium">${d}</span></span>
            ${g != null && g > 0 ? `<span class="${gt}">${fmtGap(g)}</span>` : ""}
          </div>`;
      }).join("");
      footer = `<div class="mt-1.5 pt-1.5 border-t border-stone-100 flex-1 min-h-0 overflow-y-auto text-[10px]">${rows}</div>
        <button data-split-ref="${e.ref}" title="Give each execution its own full box and branch downstream"
          class="mt-1 shrink-0 w-full text-[9px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded px-1 py-0.5 leading-none">⑂ Split into ${firedCounts.get(e.ref)} branches</button>`;
    } else if (fired) {
      footer = `
          <div class="mt-auto pt-1.5 border-t border-stone-100 flex items-baseline justify-between text-[10px]">
            <span class="text-stone-700 font-medium mono">${bizLabel ?? "—"}</span>
            ${gapMin != null && gapMin > 0 ? `<span class="${gapTone}">${fmtGap(gapMin)}</span>` : ""}
          </div>`;
    }

    return `
      <div data-step="${i}" title="View the data as of this event" class="absolute cursor-pointer rounded-md border ${isPast ? "border-emerald-200" : phaseBorder} ${ringClass} ${isPast ? "bg-emerald-50" : "bg-white"} px-3 py-2 ${fired || isSelected ? "" : "opacity-60"} flex flex-col overflow-hidden"
           style="left:${pos.col * colPitch}px; top:${laneTop[pos.lane]}px; width:${cardW}px; height:${cardHeightFor(e.ref)}px; ${provHatch(provMode)}">
        <div class="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
          <span class="truncate">${i+1}. ${escapeHtml(e.boundedContext)}</span>
          <span class="flex items-center gap-1 shrink-0">
            ${e.derived ? `<span class="text-amber-600 font-semibold">DERIVED</span>` : ""}
            ${provChip(provMode)}
          </span>
        </div>
        <div class="text-[12px] font-medium leading-tight text-stone-800">${escapeHtml(e.name)}</div>
        <div class="text-[10px] text-stone-500 mt-1">${escapeHtml(e.role)}</div>
        ${footer}
      </div>
    `;
  }).join("");

  // Fired-count badges as a separate overlay layer: each bubble overhangs its
  // card's top-right corner, so it must live alongside the cards in the (non-
  // clipping) flow container rather than inside the overflow-hidden card. The
  // badge is the click target that toggles this card's expansion.
  const badges = state.events.map((e, i) => {
    const n = firedCounts.get(e.ref) || 0;
    if (n <= 1) return "";
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    return firedCountBadge(e.ref, n, pos.col * colPitch + cardW, laneTop[pos.lane], isExpanded(e.ref));
  }).join("");

  // Connectors: a smooth S-curve from each predecessor's right edge to the
  // event's left edge. Anchored to each card's header band (top + cardH/2) so an
  // expanded card growing downward doesn't drag its edges off the header line.
  // Edges whose target has fired are drawn dark; pending edges stay faint, so
  // the lit path tracks how far the run has progressed.
  const paths = layout.edges.map(({ from, to }) => {
    const a = layout.place.get(from), b = layout.place.get(to);
    if (!a || !b) return "";
    const fired = firedRefs.has(to); // edge lit when its target event has fired (gap-safe)
    const d = flowEdgePath(a, b, layout.waypoints.get(`${from}->${to}`), laneTop, laneHeight, FLOW);
    return `<path d="${d}" fill="none" stroke="${fired ? "#78716c" : "#e7e5e4"}" stroke-width="2" marker-end="url(#flow-arrow)"/>`;
  }).join("");

  const svg = layout.edges.length ? `
        <svg width="${W}" height="${H}" class="absolute top-0 left-0" style="pointer-events:none;">
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e"/>
            </marker>
          </defs>
          ${paths}
        </svg>` : "";

  return `
    <section class="border-b border-stone-200 bg-stone-50">
      ${timelineLegend()}
      <div id="timeline-scroll" class="px-6 py-3 overflow-x-auto">
        <div style="width:${W}px;">
          <div class="relative" style="width:${W}px; height:${H}px;">
            ${svg}
            ${cards}
            ${badges}
          </div>
          <div class="h-1 bg-stone-200 rounded overflow-hidden mt-3" style="width:${W}px;">
            <div class="h-1 bg-amber-400 transition-all duration-300" style="width:${pct}%"></div>
          </div>
        </div>
      </div>
    </section>
  `;
}

// Provenance legend + "last event" strip shared by the flow and branch views.
function timelineLegend() {
  const prov = state.meta.provenance;
  return `
      <div class="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
        ${prov ? `
        <span class="font-semibold text-stone-600">${prov.steps.real} of ${prov.steps.total} steps from a real source</span>
        <span class="flex items-center gap-1">${provChip("live")} live</span>
        <span class="flex items-center gap-1">${provChip("recorded")} recorded</span>
        <span class="flex items-center gap-1">${provChip("simulated")} simulated</span>` : ""}
        ${lastEventInline()}
      </div>`;
}

// Branch view: the shared spine up to the split event, then one full branch per
// execution downstream (the FK-threaded instance forest from buildBranchForest).
// Stacks vertically and scrolls — there can be many executions.
function splitTimelineView(layout, splitRef, firedCounts) {
  const { cardW, cardH, colPitch, rowPitch } = SPLIT_FLOW;
  const eventByRef = new Map(state.events.map((e) => [e.ref, e]));
  const splitEvent = eventByRef.get(splitRef);
  const splitName = splitEvent ? splitEvent.name : splitRef.split("/").pop();

  const firings = caseFirings(layout);
  const { roots, splitCol } = buildBranchForest(splitRef, layout, firings);
  const totalRows = Math.max(1, layoutForestRows(roots));

  // Flatten the forest into positioned boxes + parent→child edges.
  const fnodes = [];
  const fedges = [];
  const walk = (n) => { fnodes.push(n); for (const c of n.children) { fedges.push([n, c]); walk(c); } };
  roots.forEach(walk);

  // Spine = events left of the split column, kept on one shared row pinned to
  // the top of the view (row 0). The right-most spine event feeds every branch
  // root; the fan opens downward beneath it.
  const spineRow = 0;
  const spineEvents = state.events
    .filter((e) => (layout.place.get(e.ref)?.col ?? 0) < splitCol)
    .map((e) => ({ e, col: layout.place.get(e.ref).col }))
    .sort((a, b) => a.col - b.col);
  const feeder = spineEvents[spineEvents.length - 1] || null;

  const maxCol = Math.max(splitCol, ...fnodes.map((n) => n.f.col), ...spineEvents.map((s) => s.col));
  const W = maxCol * colPitch + cardW;
  const H = totalRows * rowPitch;
  const xOf = (col) => col * colPitch;
  const yOf = (row) => row * rowPitch + (rowPitch - cardH) / 2;
  const rEdge = (col) => xOf(col) + cardW;
  const midY = (row) => yOf(row) + cardH / 2;
  const curve = (sx, sy, ex, ey, stroke) => {
    const dx = Math.max(20, (ex - sx) * 0.5);
    return `<path d="M${sx},${sy} C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}" fill="none" stroke="${stroke}" stroke-width="1.5" marker-end="url(#flow-arrow-split)"/>`;
  };

  // Each execution box: the model event it is, the entity's own name, its date.
  const forestCards = fnodes.map((n) => {
    const f = n.f;
    const ev = eventByRef.get(f.ref);
    const label = f.payload.name || f.payload.title || shortId(f.aggId);
    const date = fmtBizDate(f.businessAt) ?? "—";
    return `<div class="absolute rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 flex flex-col overflow-hidden shadow-sm"
         style="left:${xOf(f.col)}px; top:${yOf(n.row)}px; width:${cardW}px; height:${cardH}px;">
        <div class="text-[9px] text-stone-500 truncate">${ev ? escapeHtml(ev.name) : escapeHtml(f.ref.split("/").pop())}</div>
        <div class="text-[11px] font-semibold leading-tight text-stone-800 truncate" title="${escapeHtml(String(label))}">${escapeHtml(String(label))}</div>
        <div class="mt-auto text-[9px] text-stone-500 mono">${date}</div>
      </div>`;
  }).join("");

  // Spine boxes: shared model steps, with a static ×N where the step fanned.
  const spineCards = spineEvents.map(({ e, col }) => {
    const n = firedCounts.get(e.ref) || 0;
    const cnt = n > 1 ? `<span class="ml-1 text-emerald-700 font-bold">×${n}</span>` : "";
    return `<div class="absolute rounded-md border border-stone-300 bg-white px-2.5 py-1.5 flex flex-col overflow-hidden"
         style="left:${xOf(col)}px; top:${yOf(spineRow)}px; width:${cardW}px; height:${cardH}px;">
        <div class="text-[9px] text-stone-500 truncate">${escapeHtml(e.boundedContext)}</div>
        <div class="text-[11px] font-semibold leading-tight text-stone-800 truncate">${escapeHtml(e.name)}${cnt}</div>
        <div class="mt-auto text-[9px] text-stone-400 truncate">${escapeHtml(e.role || "")}</div>
      </div>`;
  }).join("");

  const fpaths = fedges.map(([p, c]) => curve(rEdge(p.f.col), midY(p.row), xOf(c.f.col), midY(c.row), "#34d399")).join("");
  const spinePaths = spineEvents.slice(1).map((s, k) => {
    const a = spineEvents[k]; // previous
    return curve(rEdge(a.col), midY(spineRow), xOf(s.col), midY(spineRow), "#78716c");
  }).join("");
  const rootPaths = feeder
    ? roots.map((rt) => curve(rEdge(feeder.col), midY(spineRow), xOf(rt.f.col), midY(rt.row), "#34d399")).join("")
    : "";

  const svg = `
        <svg width="${W}" height="${H}" class="absolute top-0 left-0" style="pointer-events:none;">
          <defs>
            <marker id="flow-arrow-split" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e"/>
            </marker>
          </defs>
          ${spinePaths}${rootPaths}${fpaths}
        </svg>`;

  const header = `
      <div class="px-6 py-2 flex items-center gap-3 text-[11px] bg-emerald-50 border-b border-emerald-200">
        <span class="font-semibold text-emerald-800">⑂ Branched by "${escapeHtml(splitName)}" — ${roots.length} execution${roots.length === 1 ? "" : "s"}</span>
        <span class="text-stone-500">${fnodes.length} box${fnodes.length === 1 ? "" : "es"} · ${totalRows} branch row${totalRows === 1 ? "" : "s"}</span>
        <button id="btn-merge-branches" class="ml-auto text-[11px] font-medium px-2.5 py-1 rounded-md border border-emerald-300 bg-white hover:bg-emerald-100 text-emerald-800">↩ Merge branches</button>
      </div>`;

  return `
    <section class="border-b border-stone-200 bg-stone-50">
      ${timelineLegend()}
      ${header}
      <div id="timeline-scroll" class="px-6 py-3 overflow-auto" style="max-height:72vh;">
        <div class="relative" style="width:${W}px; height:${H}px;">
          ${svg}
          ${spineCards}
          ${forestCards}
        </div>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Finder-style segmented view switcher — the three representations of this
// workflow's cases: the merged "Workflow" flow (all cases on one diagram with a
// counter on each event), the "By case" flow (the same flow split into one row
// per case), and the case List. Sits top-right in the header, just left of the
// Assistant button. Plain anchors so hash routing drives it.
// `active` ∈ "flow" | "rows" | "list" | null. null = a case drill-down (no mode
// is current; any segment pops back out). #list / #flow / #rows are explicit;
// bare # is the smart default (loadOverview).
// ---------------------------------------------------------------------------
function viewSwitcher(active) {
  const seg = (href, label, on, title) =>
    `<a href="${href}" class="px-2.5 py-1 rounded ${on ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"} whitespace-nowrap transition-colors" title="${escapeHtml(title)}">${label}</a>`;
  return `
    <div class="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-stone-300 bg-stone-100 text-sm" role="group" aria-label="View">
      ${seg("#flow", "⑂ Workflow", active === "flow", "All cases merged onto one flow, with a counter on each event")}
      ${seg("#rows", "▦ By case", active === "rows", "The same flow split into one row per case")}
      ${seg("#list", "▤ List", active === "list", "Every case as a list — pick one to follow it end to end")}
    </div>`;
}

// Merged flow (#flow): the whole model DAG with a counter on each event = how
// many times it fired ACROSS ALL CASES (state.flow.counts). Reuses the
// single-case layout, card geometry and edge SVG; it deliberately drops the
// per-case extras (branch split, per-firing rows, business dates/gaps) since
// there is no single timeline here — those merge away into the counts. Cards
// that never fired stay ghosted; fired cards tint by relative volume so the
// hotspots in the flow pop out.
function mergedTimeline() {
  const counts = state.flow?.counts || {};
  const total = state.events.length;
  const firedRefs = new Set(state.events.filter((e) => (counts[e.ref] || 0) > 0).map((e) => e.ref));
  const firedSteps = firedRefs.size;
  const maxCount = Math.max(1, ...state.events.map((e) => counts[e.ref] || 0));

  const layout = computeFlowLayout(state.events);
  const { cardW, cardH, colPitch, rowPitch } = FLOW;
  // Lanes that carry only a routed (skip) edge get a short row; card lanes keep
  // the full card height. With no routed edges this is exactly the old uniform
  // `L * rowPitch` grid (cardH + laneGap === rowPitch), so flows without skips
  // are unchanged.
  const laneGap = rowPitch - cardH;
  const cardLanes = new Set(Array.from(layout.place.values(), (p) => p.lane));
  const laneHeight = Array.from({ length: layout.lanes }, (_, L) => cardLanes.has(L) ? cardH : ROUTE_ROW);
  const laneTop = [];
  for (let L = 0, acc = 0; L < layout.lanes; L++) { laneTop[L] = acc; acc += laneHeight[L] + laneGap; }
  const W = (layout.cols - 1) * colPitch + cardW;
  const H = layout.lanes ? laneTop[layout.lanes - 1] + laneHeight[layout.lanes - 1] : cardH;

  const cards = state.events.map((e, i) => {
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    const n = counts[e.ref] || 0;
    const fired = n > 0;
    const phaseBorder = PHASE_TONE[e.phase] || "border-stone-300";
    const provMode = provModeForBC(e.boundedContext);
    // Heat: relative volume → emerald background tint (fired cards only). Floor
    // keeps low-volume fired cards visibly "on"; ceiling stays readable.
    const heat = fired ? (0.1 + 0.45 * (n / maxCount)).toFixed(3) : 0;
    const heatStyle = fired ? `background-color:rgba(16,185,129,${heat});` : "";
    return `
      <div class="absolute rounded-md border ${fired ? "border-emerald-300" : phaseBorder} bg-white px-3 py-2 ${fired ? "" : "opacity-60"} flex flex-col overflow-hidden"
           style="left:${pos.col * colPitch}px; top:${laneTop[pos.lane]}px; width:${cardW}px; height:${cardH}px; ${heatStyle} ${provHatch(provMode)}">
        <div class="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
          <span class="truncate">${i + 1}. ${escapeHtml(e.boundedContext)}</span>
          ${provChip(provMode)}
        </div>
        <div class="text-[12px] font-medium leading-tight text-stone-800">${escapeHtml(e.name)}</div>
        <div class="text-[10px] text-stone-500 mt-1">${escapeHtml(e.role)}</div>
      </div>`;
  }).join("");

  // Fired-count badges as a separate overlay layer (the same ×N corner bubble the
  // detail view uses): each overhangs its card's top-right corner = how many times
  // that event triggered across all cases. Sibling of the cards so it can overhang
  // the edge (cards clip their own children).
  const badges = state.events.map((e, i) => {
    const n = counts[e.ref] || 0;
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    return flowCountBadge(n, pos.col * colPitch + cardW, laneTop[pos.lane], `${e.name} triggered ${n}× across all cases`);
  }).join("");

  // Connectors: same S-curve as the single-case flow; an edge is lit (dark) when
  // its target event fired in at least one case, faint otherwise.
  const paths = layout.edges.map(({ from, to }) => {
    const a = layout.place.get(from), b = layout.place.get(to);
    if (!a || !b) return "";
    const lit = firedRefs.has(to);
    const d = flowEdgePath(a, b, layout.waypoints.get(`${from}->${to}`), laneTop, laneHeight, FLOW);
    return `<path d="${d}" fill="none" stroke="${lit ? "#78716c" : "#e7e5e4"}" stroke-width="2" marker-end="url(#flow-arrow)"/>`;
  }).join("");

  const svg = layout.edges.length ? `
        <svg width="${W}" height="${H}" class="absolute top-0 left-0" style="pointer-events:none;">
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e"/>
            </marker>
          </defs>
          ${paths}
        </svg>` : "";

  const cases = state.flow?.totalCases ?? 0;
  const pct = total ? (firedSteps / total) * 100 : 0;
  return `
    <section class="border-b border-stone-200 bg-stone-50">
      <div class="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
        <span class="font-semibold text-stone-600">${state.flow?.totalFirings ?? 0} firings across ${cases} case${cases === 1 ? "" : "s"}</span>
        <span class="text-stone-300">·</span>
        <span>${firedSteps} of ${total} events triggered</span>
        <span class="ml-auto italic text-stone-400">The ×N badge on an event counts its firings across all cases</span>
      </div>
      <div id="timeline-scroll" class="px-6 py-3 overflow-x-auto">
        <div style="width:${W}px;">
          <div class="relative" style="width:${W}px; height:${H}px;">
            ${svg}
            ${cards}
            ${badges}
          </div>
          <div class="h-1 bg-stone-200 rounded overflow-hidden mt-3" style="width:${W}px;">
            <div class="h-1 bg-emerald-400 transition-all duration-300" style="width:${pct}%"></div>
          </div>
        </div>
      </div>
    </section>`;
}

// Merged-flow page (#flow): the all-cases overview. Same header shape as the
// dashboard so the two read as siblings under Overview; the scope bar lets the
// user hop back to the case list (and from there into a single case).
function mergedFlowView() {
  const m = state.meta;
  const plural = prettyEntity(m.rootAggregatePlural);
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(m.title)} — merged flow</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">All ${escapeHtml(plural.toLowerCase())} on one flow</div>
        </div>
        ${viewSwitcher("flow")}
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    ${mergedTimeline()}
    <main class="flex-1 overflow-auto p-6">
      <p class="text-sm text-stone-500 max-w-3xl">Every case in this workflow, merged onto the model flow. The ×N badge on an event counts how many times it triggered across all ${escapeHtml(plural.toLowerCase())}; brighter cards are busier steps. Switch to <a href="#rows" class="text-stone-800 underline">By case</a> to split it into one row per case, or <a href="#list" class="text-stone-800 underline">List</a> to follow a single case end to end.</p>
    </main>`;
}

// Per-case flow (#rows): the merged flow split into one row per case. Each row is
// a scoped copy of the Workflow view's 2-D layout — same column/lane placement,
// spine, branches and routed skip edges, card geometry, phase border, provenance
// chip/hatch and emerald heat — lit for one case: a card is "on" (emerald, tinted)
// where that case fired the step, ghosted where it didn't, with the same ×N corner
// badge when a step fired more than once; the connector edges between them light
// only where the case actually flowed. The left gutter names the case; the row
// links into its full detail.
function rowsTimeline() {
  const rows = state.flowRows?.cases || [];
  const layout = computeFlowLayout(state.events);
  const { cardW, cardH, colPitch, rowPitch } = FLOW;
  const labelW = 210;

  if (!rows.length) {
    return `<section class="border-b border-stone-200 bg-stone-50 px-6 py-10 text-center text-sm text-stone-400">No cases have fired yet — run a case (or switch to <a href="#list" class="underline">List</a> and add one) to see it appear as a row here.</section>`;
  }

  // 2-D geometry, identical for every case row (same model topology): the spine,
  // its branches and the routed skip edges land exactly where the Workflow view
  // puts them — only which cards/edges are lit changes per case. Mirrors
  // mergedTimeline's lane math: card lanes keep full height, a lane carrying only
  // a routed edge is short, and laneTop stacks them with the usual gutter.
  const laneGap = rowPitch - cardH;
  const cardLanes = new Set(Array.from(layout.place.values(), (p) => p.lane));
  const laneHeight = Array.from({ length: layout.lanes }, (_, L) => cardLanes.has(L) ? cardH : ROUTE_ROW);
  const laneTop = [];
  for (let L = 0, acc = 0; L < layout.lanes; L++) { laneTop[L] = acc; acc += laneHeight[L] + laneGap; }
  const gridW = (layout.cols - 1) * colPitch + cardW;
  const rowH = layout.lanes ? laneTop[layout.lanes - 1] + laneHeight[layout.lanes - 1] : cardH;

  // Heat is comparable across rows: tint each fired card by its count relative to
  // the busiest single (case, step) anywhere in view.
  let maxCount = 1;
  for (const c of rows) for (const ref in (c.counts || {})) maxCount = Math.max(maxCount, c.counts[ref]);

  // Each row's gutter shows that case's first (up to 3) mandatory attributes,
  // joined from the case rows by id. Fall back to the first plain columns when the
  // model marks nothing required.
  const caseById = new Map((state.cases || []).map((r) => [String(r.id), r]));
  let attrKeys = state.meta?.rootMandatoryAttributes || [];
  if (!attrKeys.length) attrKeys = genericColumns(state.cases || []);
  attrKeys = attrKeys.slice(0, 3);

  // Edge geometry is the model topology, identical for every row; only which edges
  // are "lit" changes per case. Same lane placement + waypoint routing as the
  // Workflow view, so a spine shortcut runs straight and a skip edge bows onto its
  // routed row exactly as it does there.
  const edgeGeom = layout.edges.map(({ from, to }) => {
    const a = layout.place.get(from), b = layout.place.get(to);
    if (!a || !b) return null;
    const d = flowEdgePath(a, b, layout.waypoints.get(`${from}->${to}`), laneTop, laneHeight, FLOW);
    return { d, to };
  }).filter(Boolean);

  const rowsHtml = rows.map((c) => {
    const counts = c.counts || {};
    const firedRefs = new Set(state.events.filter((e) => (counts[e.ref] || 0) > 0).map((e) => e.ref));

    const cards = state.events.map((e, i) => {
      const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
      const n = counts[e.ref] || 0;
      const fired = n > 0;
      const phaseBorder = PHASE_TONE[e.phase] || "border-stone-300";
      const provMode = provModeForBC(e.boundedContext);
      const heat = fired ? (0.1 + 0.45 * (n / maxCount)).toFixed(3) : 0;
      const heatStyle = fired ? `background-color:rgba(16,185,129,${heat});` : "";
      return `
        <div class="absolute rounded-md border ${fired ? "border-emerald-300" : phaseBorder} bg-white px-3 py-2 ${fired ? "" : "opacity-60"} flex flex-col overflow-hidden"
             style="left:${pos.col * colPitch}px; top:${laneTop[pos.lane]}px; width:${cardW}px; height:${cardH}px; ${heatStyle} ${provHatch(provMode)}">
          <div class="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
            <span class="truncate">${i + 1}. ${escapeHtml(e.boundedContext)}</span>
            ${provChip(provMode)}
          </div>
          <div class="text-[12px] font-medium leading-tight text-stone-800">${escapeHtml(e.name)}</div>
          <div class="text-[10px] text-stone-500 mt-1">${escapeHtml(e.role)}</div>
        </div>`;
    }).join("");

    // Same ×N corner badge as the detail / merged views (hidden when a step fired
    // just once for this case, which is the norm — the green card already says it
    // ran). Sibling layer so it can overhang the card's top-right corner.
    const badges = state.events.map((e, i) => {
      const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
      const n = counts[e.ref] || 0;
      return flowCountBadge(n, pos.col * colPitch + cardW, laneTop[pos.lane], `${e.name} fired ${n}× for this case`);
    }).join("");

    const paths = edgeGeom.map(({ d, to }) =>
      `<path d="${d}" fill="none" stroke="${firedRefs.has(to) ? "#78716c" : "#e7e5e4"}" stroke-width="2" marker-end="url(#rows-arrow)"/>`
    ).join("");
    const svg = edgeGeom.length
      ? `<svg width="${gridW}" height="${rowH}" class="absolute top-0 left-0" style="pointer-events:none;">${paths}</svg>`
      : "";

    const id = String(c.caseId);
    // Mandatory-attribute lines: the first as the row's headline (bold value),
    // the rest as "name: value". Falls back to the short id if a case carries no
    // attribute values at all.
    const caseRow = caseById.get(id) || {};
    const attrLines = attrKeys.map((k, ai) => {
      const val = attrText(caseRow[k]);
      const label = prettyEntity(k);
      return ai === 0
        ? `<div class="text-[10px] font-semibold text-stone-800 truncate" title="${escapeHtml(label)}: ${escapeHtml(val)}">${escapeHtml(val)}</div>`
        : `<div class="text-[10px] text-stone-500 truncate" title="${escapeHtml(label)}: ${escapeHtml(val)}"><span class="text-stone-400">${escapeHtml(label)}:</span> ${escapeHtml(val)}</div>`;
    }).join("");
    const headline = attrLines || `<div class="text-[10px] font-semibold text-stone-800 truncate mono">${escapeHtml(id.slice(0, 12))}…</div>`;
    return `
      <a href="#case/${encodeURIComponent(id)}" class="flex items-stretch border-t border-stone-200 hover:bg-stone-50 group">
        <div class="group/case relative sticky left-0 z-20 bg-white group-hover:bg-stone-50 shrink-0 border-r border-stone-200 px-3 flex flex-col justify-center" style="width:${labelW}px;">
          <span role="button" tabindex="0" data-copy-case="${escapeHtml(id)}" title="Copy this case's ID to the clipboard"
            class="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/case:opacity-100 focus:opacity-100 transition-opacity p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/70 cursor-pointer">${iconCopy}</span>
          <div class="min-w-0 group-hover/case:pr-5 transition-[padding] duration-150">
            ${headline}
            ${c.startAt || c.lastAt ? (() => {
              const start = c.startAt || c.lastAt;
              const active = c.lastAt && c.lastAt !== start;
              // Two labeled lines so neither reads as a contradiction: the start is an
              // absolute business date, the last activity a relative time. The "Active"
              // line only appears when the case moved on after it started.
              const startLine = `<div title="${escapeHtml(`Started ${new Date(start).toLocaleString()}`)}"><span class="text-stone-400">Started</span> <span class="text-stone-600 font-medium">${escapeHtml(timeAgo(start))}</span></div>`;
              const activeLine = active
                ? `<div title="${escapeHtml(`Last activity ${new Date(c.lastAt).toLocaleString()}`)}"><span class="text-stone-400">Active</span> <span class="text-stone-600 font-medium">${escapeHtml(timeAgo(c.lastAt))}</span></div>`
                : "";
              return `<div class="text-[10px] text-stone-400 mt-1 leading-tight space-y-0.5">${startLine}${activeLine}</div>`;
            })() : ""}
          </div>
        </div>
        <div class="relative shrink-0 my-2" style="width:${gridW}px; height:${rowH}px;">
          ${svg}${cards}${badges}
        </div>
      </a>`;
  }).join("");

  const total = state.flowRows?.totalCases ?? rows.length;
  const truncated = total > rows.length;
  const totalW = labelW + gridW;
  return `
    <section class="border-b border-stone-200 bg-white">
      <div class="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200">
        <span class="font-semibold text-stone-600">${rows.length}${truncated ? ` of ${total}` : ""} case${total === 1 ? "" : "s"}</span>
        <span class="text-stone-300">·</span>
        <span>one row per case, most recently active first</span>
        ${truncated
          ? `<button type="button" data-show-all-cases title="Load every case (may be slow for very large workflows)" class="ml-auto italic text-amber-600 hover:text-amber-700 hover:underline cursor-pointer">Showing the ${rows.length} most recent of ${total} — show all</button>`
          : `<span class="ml-auto italic text-stone-400">Click a row to follow that case end to end</span>`}
      </div>
      <div class="overflow-x-auto">
        <svg width="0" height="0" class="absolute"><defs>
          <marker id="rows-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e"/>
          </marker>
        </defs></svg>
        <div style="min-width:${totalW}px;">${rowsHtml}</div>
      </div>
    </section>`;
}

// Per-case flow page (#rows): same header shape as the merged flow so they read
// as siblings; the switcher hops between them and the List.
function flowRowsView() {
  const m = state.meta;
  const singular = prettyEntity(m.rootAggregate);
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(m.title)} — by case</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">Each ${escapeHtml(singular.toLowerCase())} as its own row</div>
        </div>
        ${viewSwitcher("rows")}
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    ${rowsTimeline()}
    <main class="flex-1 overflow-auto p-6">
      <p class="text-sm text-stone-500 max-w-3xl">The merged flow split into one row per case — each row shows how far that ${escapeHtml(singular.toLowerCase())} got through the steps and which it triggered. Click a row to follow that case end to end, or switch to <a href="#flow" class="text-stone-800 underline">Workflow</a> for the combined view.</p>
    </main>`;
}

// Per-row "copy case ID" control in the by-case gutter. The control lives inside
// the row's <a>, so the handler must swallow the click (preventDefault) to copy
// without also navigating into the case. Keyboard-activatable (it's a role=button
// span). Re-bound on every render of the view.
function bindFlowRows() {
  document.querySelector("[data-show-all-cases]")?.addEventListener("click", () => {
    state.flowRowsShowAll = true;
    loadFlowRows();
  });
  document.querySelectorAll("[data-copy-case]").forEach((el) => {
    el.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); copyCaseId(el); });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); copyCaseId(el); }
    });
  });
}

async function copyCaseId(el) {
  const id = el.getAttribute("data-copy-case");
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    // Fallback for non-secure contexts / browsers without the async clipboard API.
    const ta = document.createElement("textarea");
    ta.value = id; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  }
  // Brief check + "Copied!" feedback, pinned visible, then restored.
  el.innerHTML = iconCheck;
  el.setAttribute("title", "Copied!");
  el.classList.add("text-emerald-600", "opacity-100");
  setTimeout(() => {
    el.innerHTML = iconCopy;
    el.setAttribute("title", "Copy this case's ID to the clipboard");
    el.classList.remove("text-emerald-600", "opacity-100");
  }, 1200);
}

// Compact "Last event" summary, folded onto the right of the timeline legend
// row (was its own full-width band). The full chronological history now lives in
// the assistant sidebar's "Event log" tab.
function lastEventInline() {
  if (!state.log || state.log.length === 0) {
    return `<span class="ml-auto text-stone-400 italic">No events yet — press <b class="not-italic font-semibold">Step forward</b></span>`;
  }
  const last = state.log[0];
  return `
    <span class="ml-auto flex items-center gap-1.5 min-w-0">
      <span class="uppercase tracking-widest text-stone-400 font-semibold">Last event</span>
      <span class="font-medium text-stone-800 truncate">${escapeHtml(last.eventName)}</span>
      ${provChip(last.provenance)}
      <span class="text-stone-300">·</span>
      <span class="mono text-stone-500">${escapeHtml(last.boundedContext)}</span>
      <span class="text-stone-300">·</span>
      <span class="text-stone-500">${escapeHtml(last.role)}</span>
      <span class="text-stone-300">·</span>
      <span class="text-stone-400">${new Date(last.occurredAt).toLocaleTimeString()}</span>
    </span>`;
}

function detailView() {
  return genericDetailView();
}

// ---------------------------------------------------------------------------
// Model-generic per-run detail. The run is one root-aggregate instance plus the
// rows each event created; this view shows them as a relationship FOREST (child
// aggregates nested under the aggregate root they belong to, e.g. invoice rows
// under their invoice) and marks what the last event changed.
// ---------------------------------------------------------------------------

// Platform/bookkeeping columns we never surface as business fields.
const GEN_HIDDEN = new Set(["version", "createdAt", "updatedAt", "_provenance"]);

// --- point-in-time ("as of" a selected event) -------------------------------
// When the user selects a timeline event, the data view is reconstructed as it
// stood the moment that event fired — without any server round-trip or
// destructive replay. Every EventLog entry's payload already captures the
// command's args plus the resulting `status` (see commands/base emitFor), and
// the whole log is already loaded in state.log, so we just fold the payloads of
// the events up to & including the selected step. Fields a command never carried
// (e.g. columns filled from exampleData at create, which are time-invariant)
// keep their value from the live row; command-carried fields that have not been
// set yet by the cutoff read blank ("not yet established at this point").
// Payloads are parsed with the shared parsePayload() helper (returns {} for
// empty/bad data, so an empty payload folds to nothing).

// Map event ref → its declared index in state.events (the same index the
// timeline's data-step encodes), so a log entry can be placed against the cutoff.
function eventRefIndex() {
  const m = new Map();
  state.events.forEach((e, i) => m.set(e.ref, i));
  return m;
}

// id → { agg, row } over the LIVE instance, for static-field carry-over.
function liveRowsById(inst) {
  const m = new Map();
  if (inst.root && inst.root.id != null) m.set(String(inst.root.id), { agg: inst.rootAggregate, row: inst.root });
  for (const [agg, rows] of Object.entries(inst.entities || {})) {
    for (const row of rows || []) if (row.id != null) m.set(String(row.id), { agg, row });
  }
  return m;
}

// Reconstruct the whole instance from the event log, folding only the entries
// the predicate accepts (by declared step index). `everCarried` (per-aggregate
// set of fields any command ever carried, full-log) lets us blank a column that
// only a LATER command sets vs. carry a time-invariant column from the live row.
function reconstructInstance(includeIdx, everCarried, live, refIdx, chrono) {
  const folded = new Map(); // id → { agg, row }
  for (const ev of chrono) {
    if (!ev.aggregateId) continue;            // skip markers (empty aggregateId)
    const idx = refIdx.get(ev.eventRef);
    if (idx == null || !includeIdx(idx)) continue;
    const p = parsePayload(ev.payload);
    if (!p || Object.keys(p).length === 0) continue; // empty/bad payload folds to nothing
    const id = String(ev.aggregateId);
    let cur = folded.get(id);
    if (!cur) folded.set(id, (cur = { agg: ev.aggregateRoot, row: {} }));
    Object.assign(cur.row, p);              // later (chronological) values win
  }
  const entities = {};
  let root = null;
  for (const [id, { agg, row: asOf }] of folded) {
    const liveRow = live.get(id)?.row || {};
    const carried = everCarried.get(id) || new Set();
    const out = { id };
    const cols = new Set([...Object.keys(liveRow), ...Object.keys(asOf)]);
    for (const c of cols) {
      if (c === "id") continue;
      if (c in asOf) out[c] = asOf[c];                 // value as of the cutoff
      else if (carried.has(c)) out[c] = null;          // a command sets it only later → not yet established
      else out[c] = liveRow[c];                        // never command-carried → time-invariant
    }
    if (agg === state.instance.rootAggregate && id === String(state.instance.root?.id ?? "")) root = out;
    else (entities[agg] ??= []).push(out);
  }
  return { instanceId: state.instance.instanceId, rootAggregate: state.instance.rootAggregate, root, entities, events: state.instance.events };
}

// The instance to render: the live one, or — when a step is selected — a
// reconstruction of every aggregate's state as of that step. Also stashes
// state.asOfPrev = the reconstruction of the state JUST BEFORE the selected
// event's firings, so the data view can highlight exactly what that event
// changed (across all its firings) by diffing as-of − before.
function activeDetailInstance() {
  const inst = state.instance || {};
  if (state.selectedStep == null || !state.instance) { state.asOfPrev = null; return inst; }
  const sel = state.selectedStep;
  const refIdx = eventRefIndex();
  const chrono = (state.log || []).slice().reverse(); // state.log is newest-first

  // Fields any command EVER carried, per aggregate (full log) — lets us tell a
  // time-varying column (blank until its command fires) from a static one.
  const everCarried = new Map();
  for (const ev of chrono) {
    if (!ev.aggregateId) continue;
    const p = parsePayload(ev.payload);
    if (!p) continue;
    const id = String(ev.aggregateId);
    let set = everCarried.get(id);
    if (!set) everCarried.set(id, (set = new Set()));
    for (const k of Object.keys(p)) set.add(k);
  }

  const live = liveRowsById(state.instance);
  // All firings of the selected event share the declared index `sel`, so
  // "≤ sel" includes every firing of it and "< sel" excludes them all — the
  // diff is precisely the net effect of all of the selected event's firings.
  const asOf = reconstructInstance((idx) => idx <= sel, everCarried, live, refIdx, chrono);
  state.asOfPrev = reconstructInstance((idx) => idx < sel, everCarried, live, refIdx, chrono);
  return asOf;
}

// The selected event def (for the as-of banner), or null.
function selectedEventDef() {
  return state.selectedStep != null ? (state.events[state.selectedStep] || null) : null;
}

// A sub-bar shown under the timeline while a step is selected: it states what
// point in time the data view is pinned to and offers a one-click return to the
// live, latest view.
function asOfBanner() {
  const e = selectedEventDef();
  if (!e) return "";
  return `
    <div class="px-6 py-2 bg-sky-50 border-b border-sky-200 flex items-center gap-3 text-sm">
      <span class="inline-block w-2 h-2 rounded-full bg-sky-500"></span>
      <span class="text-sky-900">Showing data <span class="font-semibold">as of</span> step ${state.selectedStep + 1} · <span class="font-semibold">${escapeHtml(e.name)}</span> <span class="text-sky-700">— fields it changed are highlighted</span></span>
      <button id="btn-clear-asof" class="ml-auto px-2.5 py-1 text-xs rounded-md border border-sky-300 bg-white hover:bg-sky-100 text-sky-800 font-medium">Show latest →</button>
    </div>`;
}

// Every row in the run, tagged with its aggregate. The root instance is listed
// once under the root aggregate (the entities map may also carry it).
function genAllRows(inst, m) {
  const out = [];
  const rootId = inst.root?.id;
  if (inst.root) out.push({ agg: m.rootAggregate, row: inst.root });
  for (const [agg, rows] of Object.entries(inst.entities || {})) {
    for (const row of rows || []) {
      if (agg === m.rootAggregate && row.id === rootId) continue; // already added
      out.push({ agg, row });
    }
  }
  return out;
}

// aggregate → bounded context, read off the run's event log (so each card can
// show which system the data came from — "from the different bounded contexts").
function genBcByAgg(inst) {
  const map = {};
  for (const e of inst.events || []) {
    if (e.aggregateRoot && e.boundedContext && !map[e.aggregateRoot]) map[e.aggregateRoot] = e.boundedContext;
  }
  return map;
}

function genRowKey(agg, row) { return agg + "#" + (row.id ?? JSON.stringify(row)); }

// Relationship forest for the detail view. Every row here is an AGGREGATE-ROOT
// instance: genAllRows reads inst.root + inst.entities, and inst.entities is
// keyed by each event's aggregateRoot (see genericInstanceDetail). Aggregate
// roots are independent consistency boundaries — they reference one another by
// id (e.g. a ChannelReadiness.campaignId pointing at its Campaign) but are NOT
// composed into each other, so each renders as its own top-level box with the
// FK left visible as a plain attribute. (Owned child entities / value objects
// are not separate rows here at all: they ride embedded inside their root row
// and render as embedded tables — see `collections` in genNode.) Hence no
// cross-row nesting. Kept returning the { parentOf, childrenOf } shape that
// genNode / genericDetailView consume; both maps are simply empty.
function genRelations(allRows, m, bcByAgg) {
  return { parentOf: new Map(), childrenOf: new Map() };
}

// --- diff against the pre-step instance (what the last event touched) -------
function genPrevRow(agg, id) {
  // The diff baseline: when a step is selected, the reconstruction of the state
  // JUST BEFORE that event's firings (so we highlight what it changed); otherwise
  // the live pre-step snapshot.
  const p = state.selectedStep != null ? state.asOfPrev : state.prevInstance;
  if (!p || id == null) return undefined;
  if (agg === p.rootAggregate && p.root && p.root.id === id) return p.root;
  return (p.entities?.[agg] || []).find((r) => r.id === id);
}

// Blank-tolerant comparison so a value that was "not yet established" (null) and
// later set reads as a change, while null/undefined/"" never differ among
// themselves. Objects/arrays compare by JSON.
function asOfBlank(v) { return v === null || v === undefined || v === ""; }
function asOfNorm(v) { return asOfBlank(v) ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v)); }
// Business fields whose value the selected event established/modified: the set of
// columns that differ between the row (as-of the event) and its before-baseline.
function asOfChangedFields(row, prev) {
  const changed = new Set();
  const cols = new Set(Object.keys(row));
  if (prev) for (const k of Object.keys(prev)) cols.add(k);
  for (const k of cols) {
    if (k === "id" || GEN_HIDDEN.has(k)) continue;
    if (asOfNorm(row[k]) !== asOfNorm(prev ? prev[k] : undefined)) changed.add(k);
  }
  return changed;
}
// The aggregate instance the most recent event touched, read off the event log.
// This is the baseline on the FIRST view of a run: the create event (e.g. the
// root "Campaign Drafted") fires server-side at run start, so there is no
// client-side pre-step snapshot to diff against — without this, that first step
// would light up nothing even though every field is brand new.
function genLastTouched() {
  const last = state.log && state.log[0];
  if (!last || !last.aggregateRoot || !last.aggregateId) return null;
  return { agg: last.aggregateRoot, id: String(last.aggregateId) };
}
function genRowChanged(agg, row) {
  // As-of view: a row "changed" iff the selected event (any firing) established or
  // modified at least one of its business fields.
  if (state.selectedStep != null) return asOfChangedFields(row, genPrevRow(agg, row.id)).size > 0;
  const prev = genPrevRow(agg, row.id);
  if (state.prevInstance) {
    if (!prev) return true; // created by the last event
    return JSON.stringify(prev) !== JSON.stringify(row);
  }
  // No pre-step snapshot yet → fall back to the event log's last-touched
  // aggregate so the create step (and a hard page reload) still highlight.
  const lt = genLastTouched();
  return !!lt && lt.agg === agg && row.id != null && String(row.id) === lt.id;
}
function genFieldChanged(agg, row, field) {
  // As-of view: only the fields the selected event's firings established/modified.
  if (state.selectedStep != null) return asOfChangedFields(row, genPrevRow(agg, row.id)).has(field);
  const prev = genPrevRow(agg, row.id);
  // Updated row with a known baseline → only the fields that actually differ.
  if (prev) return JSON.stringify(prev[field]) !== JSON.stringify(row[field]);
  // New row (or no baseline): every business field is new, so a row the last
  // event changed lights up all of its fields.
  return genRowChanged(agg, row);
}
// The previous step's value of an embedded-collection field, parsed to rows, so
// genEmbeddedTable can highlight only the rows that are new/changed. Null when
// there's no baseline (new parent row / first view) → all rows count as new.
function genPrevCollection(agg, row, field) {
  const prev = genPrevRow(agg, row.id);
  return prev ? genParseRows(prev[field]) : null;
}

// An embedded-structure field → the rows to render as a small table under its
// row: an array of objects (cart items, invoice lines), or a single object (a
// value object like targetAudience) as one row. Values may arrive already
// parsed or as a JSON string from the projection's TEXT column. Plain
// strings/scalars (and arrays of scalars) return null → rendered inline.
function genParseRows(v) {
  let parsed = v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t[0] !== "[" && t[0] !== "{") return null;
    try { parsed = JSON.parse(t); } catch { return null; }
  }
  if (Array.isArray(parsed)) return parsed.length && parsed[0] && typeof parsed[0] === "object" ? parsed : null;
  if (parsed && typeof parsed === "object") return [parsed];
  return null;
}

function genVal(k, v) {
  if (v == null || v === "") return "—";
  if (k === "status") return pill(String(v), String(v));
  if (typeof v === "object") return `<span class="mono text-[11px] text-stone-500">${escapeHtml(JSON.stringify(v))}</span>`;
  return escapeHtml(String(v));
}

function genEmbeddedTable(name, rows, changed, prevRows) {
  const cols = Object.keys(rows[0]).filter((c) => !GEN_HIDDEN.has(c)).slice(0, 6);
  // Light up the embedded DATA rows that are new/different vs the previous step
  // (the same yellow flash as a scalar field's value), not just the header. With
  // no baseline (new parent row / first view) every row counts as new. The header
  // only carries a small "updated" tag for context.
  const prevSet = prevRows ? prevRows.map((r) => JSON.stringify(r)) : null;
  const isNew = (r) => changed && (!prevSet || !prevSet.includes(JSON.stringify(r)));
  return `
    <div class="overflow-hidden rounded border ${changed ? "border-amber-300" : "border-stone-200"}">
      <div class="text-[10px] font-semibold uppercase tracking-wide px-2 py-1 border-b text-stone-500 bg-stone-50 border-stone-200">${escapeHtml(name)} <span class="text-stone-400 font-normal">· ${rows.length}</span>${changed ? ` <span class="ml-1 px-1 rounded bg-amber-200 text-amber-900 font-semibold">updated</span>` : ""}</div>
      <table class="w-full text-[11px]">
        <thead><tr>${cols.map((c) => `<th class="text-left font-medium text-stone-400 px-2 py-1">${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="border-t border-stone-100 ${isNew(r) ? "row-changed" : ""}">${cols.map((c) => `<td class="px-2 py-1 align-top text-stone-700">${genVal(c, r[c])}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

// One aggregate instance as a card: its fields, any embedded collections, and —
// nested beneath — the child aggregates whose foreign keys point back at it.
function genNode(agg, row, ctx, depth, prominent) {
  const rk = genRowKey(agg, row);
  if (ctx.seen.has(rk) || depth > 8) return ""; // cycle / runaway guard
  ctx.seen.add(rk);

  const changed = genRowChanged(agg, row);
  const scalars = [], collections = [];
  for (const [k, v] of Object.entries(row)) {
    if (GEN_HIDDEN.has(k) || k === "id") continue;
    const sub = genParseRows(v);
    if (sub) collections.push([k, sub]); else scalars.push([k, v]);
  }
  const grid = scalars.map(([k, v]) => {
    const fc = genFieldChanged(agg, row, k);
    return `<div><div class="text-[10px] text-stone-500">${escapeHtml(k)}</div><div class="text-[12px] text-stone-800 break-words ${fc ? "field-changed inline-block px-1" : ""}">${genVal(k, v)}</div></div>`;
  }).join("");

  const bc = ctx.bcByAgg[agg];
  const bcChip = bc ? `<span class="text-[10px] px-1.5 py-px rounded bg-stone-100 text-stone-500 border border-stone-200">${escapeHtml(bc)}</span>` : "";
  const idChip = row.id != null ? `<span class="mono text-[11px] text-stone-400">${escapeHtml(shortId(String(row.id)))}</span>` : "";
  const updatedChip = changed ? `<span class="text-[10px] px-1.5 py-px rounded bg-amber-100 text-amber-800 font-semibold uppercase tracking-wide">updated</span>` : "";

  const kids = ctx.childrenOf.get(rk) || [];
  const childHtml = kids.length
    ? `<div class="entity-nest pl-3 ml-1 mt-3 flex flex-col gap-2">${kids.map((e) => genNode(e.agg, e.row, ctx, depth + 1, false)).join("")}</div>`
    : "";

  // Embedded sub-tables (value objects / collection fields like commercialTarget,
  // budget, campaignBrief) flow into an auto-fit grid: as many side by side as
  // fit at >=260px each, wrapping to a single stacked column when there isn't
  // room. "Same row if there's space, else stack" without a fixed column count.
  const collectionsHtml = collections.length
    ? `<div class="mt-2 grid gap-3 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">${collections
        .map(([k, sub]) => genEmbeddedTable(k, sub, genFieldChanged(agg, row, k), genPrevCollection(agg, row, k)))
        .join("")}</div>`
    : "";

  return `
    <div class="rounded-lg border ${changed ? "border-amber-300 ring-1 ring-amber-200" : "border-stone-200"} bg-white ${prominent ? "p-4" : "p-3"}">
      <div class="flex items-center gap-2 mb-2">
        <span class="font-semibold text-stone-800 ${prominent ? "text-sm" : "text-[12px]"}">${escapeHtml(prettyEntity(agg))}</span>
        ${bcChip}${idChip}${updatedChip}
      </div>
      <div class="grid grid-cols-2 ${prominent ? "md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" : "sm:grid-cols-2"} gap-x-4 gap-y-1.5">${grid}</div>
      ${collectionsHtml}
      ${childHtml}
    </div>`;
}

// Model-generic per-run detail: header (reuses the btn-back/next/all/reset ids so
// the existing bindings work), the timeline, and the relationship forest.
function genericDetailView() {
  const inst = activeDetailInstance();
  const root = inst.root || {};
  const total = state.events.length;
  const m = state.meta;

  const allRows = genAllRows(inst, m);
  const bcByAgg = genBcByAgg(inst);
  const { parentOf, childrenOf } = genRelations(allRows, m, bcByAgg);
  const ctx = { bcByAgg, childrenOf, seen: new Set() };

  // Forest roots = rows with no parent; the run root renders first & prominent,
  // the rest (other DDD aggregates not reachable by an FK from the root) follow.
  const runRootKey = inst.root ? genRowKey(m.rootAggregate, inst.root) : null;
  const otherRoots = allRows.filter((e) => {
    const k = genRowKey(e.agg, e.row);
    return k !== runRootKey && !parentOf.has(k);
  });
  const rootCard = inst.root ? genNode(m.rootAggregate, inst.root, ctx, 0, true) : "";
  const otherCards = otherRoots.map((e) => genNode(e.agg, e.row, ctx, 0, false)).join("");

  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-4">
        <button id="btn-back" class="p-1.5 -ml-1 rounded text-stone-500 hover:text-stone-900 hover:bg-stone-100" title="Back to dashboard">←</button>
        <div class="flex-1 min-w-0">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(m.title)} · ${root.id ? escapeHtml(String(root.id).slice(0, 16)) + "…" : ""}</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">${escapeHtml(prettyEntity(m.rootAggregate))} ${root.status ? pill(String(root.status), String(root.status)) : ""}</div>
        </div>
        <div class="text-sm text-stone-500 mr-2 tabular-nums"><span class="font-semibold text-stone-800">${firedRefSet().size}</span> / ${total} fired</div>
        <button id="btn-reset" ${state.busy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Reset</button>
        <button id="btn-next" ${state.busy || state.currentIndex >= total ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">Step forward →</button>
        <button id="btn-all" ${state.busy || state.currentIndex >= total ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Run all</button>
        ${viewSwitcher(null)}
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    ${timeline()}
    ${asOfBanner()}
    <main class="flex-1 overflow-auto p-6 flex flex-col gap-4">
      ${rootCard}
      ${otherCards ? `<div class="grid gap-4 items-start" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${otherCards}</div>` : ""}
    </main>`;
}


// Move the selected event by the flow's 2D layout (column/lane from
// computeFlowLayout — the same geometry the cards are drawn with), NOT the linear
// sequence index. Left/right follow the current branch, bridging back onto the
// connected (usually main) branch at a sub-branch's ends; up/down cross to the
// parallel card stacked above/below. Returns true if the selection moved.
// dir ∈ "left" | "right" | "up" | "down".
function navSelect(dir) {
  if (state.selectedStep == null) return false;
  const events = state.events || [];
  const curRef = events[state.selectedStep]?.ref;
  if (!curRef) return false;
  const layout = computeFlowLayout(events);
  const cur = layout.place.get(curRef);
  if (!cur) return false;
  const idxByRef = new Map(events.map((e, i) => [e.ref, i]));
  const cells = [];
  events.forEach((e, idx) => {
    const p = layout.place.get(e.ref);
    if (p && e.ref !== curRef) cells.push({ idx, col: p.col, lane: p.lane });
  });
  let pick = null;
  if (dir === "left" || dir === "right") {
    // 1) Within the branch: nearest card in the SAME lane in that direction.
    const cands = cells.filter((c) => c.lane === cur.lane && (dir === "right" ? c.col > cur.col : c.col < cur.col));
    for (const c of cands) {
      if (!pick || (dir === "right" ? c.col < pick.col : c.col > pick.col)) pick = c;
    }
    // 2) At the branch's start/end (no same-lane card that way): bridge along the
    //    flow edge — the predecessor when going left, a successor when going right —
    //    so leaving a sub-branch continues onto the main branch instead of
    //    dead-ending on its first/last card.
    if (!pick) {
      const linked = dir === "left"
        ? (events[state.selectedStep].predecessors || [])
        : events.filter((e) => (e.predecessors || []).includes(curRef)).map((e) => e.ref);
      for (const ref of linked) {
        const p = layout.place.get(ref);
        if (!p || (dir === "left" ? p.col >= cur.col : p.col <= cur.col)) continue; // must be upstream/downstream
        const cand = { idx: idxByRef.get(ref), col: p.col, lane: p.lane };
        if (!pick || (dir === "left" ? p.col > pick.col : p.col < pick.col)) pick = cand; // nearest by column
      }
    }
  } else {
    // Directly above (up) / below (down): the parallel-branch card at the SAME
    // column, nearest lane. Nothing stacked there → no move (don't jump sideways).
    const cands = cells.filter((c) => c.col === cur.col && (dir === "up" ? c.lane < cur.lane : c.lane > cur.lane));
    for (const c of cands) {
      if (!pick || (dir === "up" ? c.lane > pick.lane : c.lane < pick.lane)) pick = c;
    }
  }
  if (!pick) return false;
  state.selectedStep = pick.idx;
  return true;
}

// Arrow keys move the selected event around the flow (only while one is selected,
// so unselected arrows keep their normal scrolling). Registered once on document
// — bindDetail() runs every render, so guard it.
let _keyNavReady = false;
function initKeyNav() {
  if (_keyNavReady) return;
  _keyNavReady = true;
  const DIRS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  document.addEventListener("keydown", (ev) => {
    if (state.view !== "detail" || state.selectedStep == null) return;
    const dir = DIRS[ev.key];
    if (!dir) return;
    // Don't hijack arrows while the user is typing in a field.
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return;
    ev.preventDefault(); // selection owns the arrows → no page/timeline scroll
    if (navSelect(dir)) render();
  });
}

function bindDetail() {
  initKeyNav();
  document.getElementById("btn-back")?.addEventListener("click", () => navigate("#"));
  document.getElementById("btn-next")?.addEventListener("click", doNext);
  document.getElementById("btn-all")?.addEventListener("click", doRunAll);
  document.getElementById("btn-reset")?.addEventListener("click", doReset);
  // ×N fired-count badges: toggle per-firing expansion (push-down reflow). The
  // expanded set persists across Step forward within a run; render() re-lays out.
  document.querySelectorAll("[data-toggle-firings]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ref = el.getAttribute("data-toggle-firings");
      if (state.expandedFirings.has(ref)) state.expandedFirings.delete(ref);
      else state.expandedFirings.add(ref);
      render();
    }));
  // "Split into branches": fan this event's executions into full per-branch
  // boxes. Collapse the row-expansion first so the flow doesn't fight the split.
  document.querySelectorAll("[data-split-ref]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ref = el.getAttribute("data-split-ref");
      state.expandedFirings.delete(ref);
      state.splitRef = ref;
      render();
    }));
  document.getElementById("btn-merge-branches")?.addEventListener("click", () => { state.splitRef = null; render(); });
  // Select a timeline event → pin the data view to its point in time (as-of
  // fold of the event log). Re-clicking the selected card clears it. The split
  // button / fired-count badge stopPropagation, so they never select.
  document.querySelectorAll("#timeline-scroll [data-step]").forEach((el) =>
    el.addEventListener("click", () => {
      const i = Number(el.getAttribute("data-step"));
      if (Number.isNaN(i)) return;
      state.selectedStep = state.selectedStep === i ? null : i;
      render();
    }));
  // Click the empty timeline background (between/around the cards) → deselect,
  // same as "Show latest". Card clicks bubble here too, so ignore any click that
  // landed on a card or its badge/split controls.
  document.getElementById("timeline-scroll")?.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-step], [data-toggle-firings], [data-split-ref]")) return;
    if (state.selectedStep == null) return;
    state.selectedStep = null;
    render();
  });
  document.getElementById("btn-clear-asof")?.addEventListener("click", () => { state.selectedStep = null; render(); });
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

function render() {
  const focusSnap = captureFocus();
  try {
    renderView();
  } finally {
    restoreFocus(focusSnap);
  }
}

function renderView() {
  // Tear down the connector code editor when leaving its view, so its DOM/listeners
  // don't leak (it's rebuilt on demand when the Code tab is next opened).
  if (state.view !== "connectors") disposeConnMonaco();
  const prevScroll = document.getElementById("timeline-scroll")?.scrollLeft ?? 0;
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
    const scroller = document.getElementById("timeline-scroll");
    if (scroller) scroller.scrollLeft = prevScroll;
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
  } else if (state.view === "rows") {
    root.innerHTML = wrap(flowRowsView());
    bindTenantBar();
    bindChat();
    bindFlowRows();
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
async function ensureMe() {
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

function selectedWorkflowId() {
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
