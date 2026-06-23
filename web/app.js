// Model-driven workflow demo UI — vanilla JS + Tailwind.
// Two views:
//   1. Dashboard:  table of demands with status + progress, "+ New demand" button.
//   2. Detail:     per-demand timeline + 7 BC panels, step-forward controls.
// Navigation is hash-based: "#" → dashboard, "#demand/<id>" → detail.

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
  view: "dashboard",     // "dashboard" | "detail"
  demands: [],
  events: [],
  busy: false,
  // model-derived UI labels (filled from /sim/meta); defaults keep the UI sane
  // before the first fetch / if the endpoint is unavailable.
  meta: { title: "Workflow", rootAggregate: "Item", rootAggregatePlural: "Items", boundedContextCount: 0, aggregateCount: 0, eventCount: 0 },
  // detail view
  demandId: null,
  instance: null,   // per-run detail from /sim/instance
  prevInstance: null, // the instance snapshot before the last step (per-run diff)
  log: [],
  currentIndex: 0,
  // per-BC adapter workbench (Part 2.3)
  bc: null,           // current bounded context (#bc/<Name>)
  bcList: null,       // /api/bc index
  bcData: null,       // /api/bc/:bc overview
  bcVerify: null,
  bcTest: null,
  bcRaw: null,
  bcCode: null,
  bcBusy: false,
  // chat
  chatOpen: false,
  chatMessages: [],      // Anthropic.MessageParam[]
  chatInput: "",
  chatBusy: false,
  chatInfo: null,        // { model, effort, apiKeyConfigured, ... }
  chatError: null,
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
  // model & versions ("Inspect model") dialog
  modelInspectOpen: false,
  modelStatus: null,    // GET /v1/workflow/model/status → { versions, current, total, currentVersion, sourceUrl }
  modelContent: null,   // GET /v1/workflow/model/content → raw current workflow.json
  modelBusy: false,     // a restore/reload is in flight
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
    throw new Error(`${res.status} ${path}: ${text}`);
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

  // When the user is on a detail page, the URL holds which demand they're
  // looking at — but the assistant never sees the URL. Inject a context
  // block so phrases like "this demand" or "the next step" resolve correctly.
  let content;
  if (state.view === "detail" && state.demandId) {
    const cur = state.demands.find((d) => d.id === state.demandId);
    const desc = cur ? `status ${cur.status ?? "—"}` : "(unknown)";
    content = [
      { type: "text", text: `[Context: viewing demand ${state.demandId} — ${desc}. When the user says "this demand", "it", or refers to a step without naming a demand, they mean this one.]` },
      { type: "text", text },
    ];
  } else if (state.view === "bc" && state.bc) {
    const a = (state.bcData && state.bcData.adapters || [])[0];
    let ctx = `[Context: viewing bounded context ${state.bc}`;
    if (a) {
      ctx += ` — adapter ${a.id} (${a.kind}, mode ${a.mode}), target entity ${a.targetEntity}`;
      if (state.bcVerify) ctx += `. Last verify: ${state.bcVerify.ok ? "ok" : "FAILED"}${state.bcVerify.detail ? " — " + state.bcVerify.detail : ""}`;
      if (state.bcTest && state.bcTest.error) ctx += `. Last dry-run error: ${state.bcTest.error}`;
      else if (state.bcTest && state.bcTest.diff) ctx += `. Last dry-run: ${state.bcTest.diff.ok ? "matched the model" : "shape mismatch"}`;
    } else {
      ctx += ` — no adapter configured yet`;
    }
    ctx += `. When the user says "this adapter", "it", or refers to the connection, they mean this one.]`;
    content = [{ type: "text", text: ctx }, { type: "text", text }];
  } else if (state.view === "bcs" && state.exp && state.exp.system) {
    const e = state.exp;
    const kind = expKindOf(e, e.entity) === "valueObject" ? "value object" : "entity";
    const conns = (e.adapters || []).map((a) => `${a.id} (${a.kind}/${a.mode}→${a.targetEntity})`).join(", ") || "none";
    const ctx = `[Context: in the Systems explorer. System (bounded context): ${e.system}. Selected table: ${e.entity || "(none)"} — a model ${kind}. Existing connectors/adapters on this system: ${conns}. When the user says "this table", "this", "it", or "fill this", they mean the selected table — build or repair a connector that populates it, following the Connector Builder loop. Confirm before create/build/ingest.]`;
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
    else if (state.view === "bcs") await refreshExplorerAfterChat();
  } catch (e) {
    state.chatError = e.message;
  } finally {
    state.chatBusy = false;
    render();
    scrollChatToBottom();
  }
}

function clearChat() {
  state.chatMessages = [];
  state.chatError = null;
  render();
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
      const WRITE_TOOLS = ["next_step", "create_demand", "regenerate_adapter_body", "reset_adapter", "create_connector", "build_connector", "ingest_connector", "remove_connector"];
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

function chatPanel() {
  if (!state.chatOpen) return "";
  const info = state.chatInfo;
  const apiOk = info?.apiKeyConfigured;
  const apiBadge = info
    ? (apiOk
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">${info.model} · ${info.effort}</span>`
        : `<span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-800">no api key</span>`)
    : `<span class="text-[10px] text-stone-400">loading…</span>`;

  const messagesHtml = state.chatMessages.map(chatMessageHtml).join("");
  const empty = state.chatMessages.length === 0;

  const builder = state.view === "bcs";
  const examples = state.view === "detail" ? [
    "Explain the next step in this workflow!",
    "Explain the last thing that was completed on this workflow.",
    "Why hasn't this demand moved forward yet?",
    "Move this demand forward one step.",
  ] : builder ? [
    "Fill this table from our DynamoDB users table",
    "Connect this to a REST API and pull the records",
    "Populate this from a Postgres query",
    "Show me the connector code",
  ] : [
    "How many demands haven't moved in 24h?",
    "Which demand is closest to being delivered?",
    "Are any demands stuck at the same step?",
    "Create a new demand.",
  ];

  return `
    <aside class="fixed top-0 right-0 bottom-0 w-[420px] bg-white border-l border-stone-200 shadow-xl flex flex-col z-30">
      <div class="px-4 py-3 border-b border-stone-200 flex items-center gap-2">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Assistant</div>
          <div class="text-sm text-stone-800 font-medium">${builder ? "Connector builder" : "Process advisor"}</div>
        </div>
        ${apiBadge}
        <button id="chat-clear" title="Clear conversation" class="text-stone-400 hover:text-stone-700 text-sm">↺</button>
        <button id="chat-close" title="Close" class="text-stone-400 hover:text-stone-700 text-lg leading-none">×</button>
      </div>

      ${!apiOk && info ? `
        <div class="px-4 py-3 bg-amber-50 border-b border-amber-200 text-[12px] text-amber-900">
          <b>ANTHROPIC_API_KEY not configured.</b> Add it to <span class="mono">.env</span> and restart the server.
        </div>
      ` : ""}

      <div id="chat-scroll" class="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        ${empty ? `
          <div class="text-stone-500 text-sm">
            ${builder
              ? `Describe any source — DynamoDB, a REST API, Postgres, a Google Sheet — and I'll write a connector to fill <b>${escapeHtml(state.exp?.entity || "this table")}</b>, test it, fix any errors, and populate it. I'll confirm before each change.`
              : "Ask about demands, the workflow, or have me advance a step. I'll always confirm before changing anything."}
            <div class="mt-3 flex flex-col gap-1.5">
              ${examples.map((q) => `<button class="text-left text-[12px] text-stone-700 hover:bg-stone-100 rounded px-2 py-1 border border-stone-200" data-example="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("")}
            </div>
          </div>
        ` : messagesHtml}
        ${state.chatBusy ? `<div class="text-stone-500 text-xs italic">thinking…</div>` : ""}
        ${state.chatError ? `<div class="text-rose-700 text-xs">⚠ ${escapeHtml(state.chatError)}</div>` : ""}
      </div>

      <div class="border-t border-stone-200 p-3">
        <textarea id="chat-input" rows="2" class="w-full text-sm border border-stone-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400 focus:border-amber-400 resize-none" placeholder="Ask anything about demands or the workflow…">${escapeHtml(state.chatInput)}</textarea>
        <div class="flex items-center gap-2 mt-2">
          <div class="flex-1 text-[10px] text-stone-400">Enter to send · Shift+Enter for new line</div>
          <button id="chat-send" ${state.chatBusy || !state.chatInput.trim() ? "disabled" : ""} class="px-3 py-1.5 text-xs rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">Send →</button>
        </div>
      </div>
    </aside>
  `;
}

function bindChat() {
  document.getElementById("chat-toggle")?.addEventListener("click", toggleChat);
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
function workflowModelControls() {
  if (!state.me) return "";
  return `
    <button id="btn-model-inspect" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 font-medium" title="Browse this workflow's model versions — reload, view, and restore">👁 Model &amp; versions</button>
    <button id="btn-proj-model" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 font-medium" title="Set or replace this workflow's model with a Qlerify model">⚙ Set model</button>`;
}

function workflowModelDialog() {
  if (!state.projModelOpen) return "";
  const err = state.projModelErr ? `<div class="text-sm text-rose-600 mb-3">${escapeHtml(state.projModelErr)}</div>` : "";
  return `
    <div class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-2xl flex flex-col max-h-[85vh]">
        <div class="px-5 py-4 border-b border-stone-200">
          <div class="text-lg font-semibold">Set this workflow's model</div>
          <div class="text-sm text-stone-500 mt-0.5">Point the workflow at a Qlerify model. It replaces <b>this workflow's</b> model and rebuilds <b>this workflow's</b> data — the demo and other workflows are untouched.</div>
        </div>
        <div class="p-5 overflow-auto flex-1">
          ${err}
          <label class="block text-sm font-medium text-stone-700 mb-1">Qlerify model link</label>
          <input id="proj-model-url" type="url" value="${escapeHtml(state.projModelUrl || "")}" class="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="https://app.qlerify.com/workflow/&lt;projectId&gt;/&lt;workflowId&gt;" />
          <div class="text-xs text-stone-500 mt-1">Paste the workflow URL from the Qlerify modeller — we'll pull the latest model.</div>
          <details class="mt-4">
            <summary class="text-sm text-stone-600 cursor-pointer select-none hover:text-stone-900">Advanced — upload or paste a workflow.json instead</summary>
            <div class="mt-3">
              <div class="mb-2 flex items-center gap-2">
                <input id="proj-model-file" type="file" accept=".json,application/json" class="text-sm" />
                <span class="text-xs text-stone-400">— or paste below —</span>
              </div>
              <textarea id="proj-model-text" class="w-full h-48 rounded-md border border-stone-300 p-2 text-xs mono" placeholder='{ "boundedContext": "...", "domainEvents": { ... } }'>${escapeHtml(state.projModelText || "")}</textarea>
            </div>
          </details>
        </div>
        <div class="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2">
          <button id="proj-model-cancel" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
          <button id="proj-model-apply" ${state.projModelBusy ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">${state.projModelBusy ? "Applying…" : "Apply to workflow"}</button>
        </div>
      </div>
    </div>`;
}

function bindWorkflowModel() {
  document.getElementById("btn-proj-model")?.addEventListener("click", () => { state.projModelOpen = true; state.projModelErr = null; render(); });
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
    try {
      await api("/v1/workflow/model", { method: "PUT", body: JSON.stringify(payload) });
      state.projModelOpen = false; state.projModelBusy = false; state.projModelText = ""; state.projModelUrl = "";
      state.modelMsg = { ok: true, text: "Workflow model updated — rebuilding this workflow." };
      await ensureMe();
      onHashChange();
      setTimeout(() => { state.modelMsg = null; render(); }, 2500);
    } catch (e) {
      state.projModelBusy = false;
      state.projModelErr = (e && e.message) ? e.message : "Failed to set the model.";
      render();
    }
  });
}

// ---------------------------------------------------------------------------
// Inspect model — version history, reload, restore, and the source link, all in
// one dialog (ported from the pre-multi-tenant build, rewired to the per-workflow
// /v1/workflow/model/* endpoints).
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

// Inspect-model dialog: version sidebar + reload/replace + the source link and a
// read-only view of the current workflow.json, all in one place.
function modelInspectDialog() {
  if (!state.modelInspectOpen) return "";
  const s = state.modelStatus;
  const total = s ? s.total : 0;
  const current = s ? s.current : -1;
  const events = s && s.currentVersion && s.currentVersion.summary ? (s.currentVersion.summary.events ?? 0) : 0;
  const versionLabel = total > 0 ? `v${current + 1}/${total}${s && s.currentVersion ? ` · ${events} events` : ""}` : "not yet versioned";
  const reloadUrl = s ? s.sourceUrl : null;
  const wfName = (state.me?.workflows || []).find((w) => w.id === state.me?.workflowId)?.name || "";
  const content = state.modelContent;
  const body = content == null
    ? `<div class="text-stone-500 text-sm p-6">Loading model…</div>`
    : `<pre class="mono text-[12px] leading-relaxed whitespace-pre p-4 overflow-auto">${escapeHtml(content)}</pre>`;
  const sizeKb = content ? Math.round(content.length / 1024) : 0;
  return `
    <div id="model-inspect-backdrop" class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
      <div class="bg-white rounded-lg shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col" role="dialog" aria-modal="true">
        <div class="px-5 py-3 border-b border-stone-200 flex flex-col gap-2.5">
          <div class="flex items-center gap-3">
            <div class="flex-1 min-w-0">
              <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Qlerify model</div>
              <div class="text-[12px] text-stone-600 tabular-nums truncate">${escapeHtml(versionLabel)}${wfName ? ` · ${escapeHtml(wfName)}` : ""}</div>
            </div>
            ${content ? `<span class="text-[11px] text-stone-400 tabular-nums shrink-0">${sizeKb} KB</span>` : ""}
            <button id="model-inspect-close" class="text-stone-400 hover:text-stone-700 text-lg leading-none shrink-0" title="Close">×</button>
          </div>
          <div class="flex items-center gap-1.5">
            <button id="btn-model-reload" ${state.modelBusy || !reloadUrl ? "disabled" : ""} class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium" title="${reloadUrl ? "Re-pull the latest model from the source link, then rebuild this workflow" : "No source link — this model was uploaded or pasted. Use Replace to re-point it."}">${state.modelBusy ? "⏳ Working…" : "⤓ Reload"}</button>
            <button id="btn-model-replace" ${state.modelBusy ? "disabled" : ""} class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium" title="Replace this workflow's model — change the link, or upload/paste a new workflow.json">✎ Replace</button>
            <span class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold shrink-0 ml-auto">Source</span>
            ${reloadUrl
              ? `<a href="${escapeHtml(reloadUrl)}" target="_blank" rel="noopener" class="min-w-0 max-w-xs text-[12px] mono text-sky-700 hover:text-sky-900 underline decoration-dotted truncate" title="${escapeHtml(reloadUrl)}">${escapeHtml(shortWorkflowUrl(reloadUrl))} ↗</a>`
              : `<span class="text-[12px] text-stone-400 italic">uploaded / pasted — no link</span>`}
          </div>
        </div>
        <div class="flex-1 flex min-h-0">
          ${modelVersionSidebar()}
          <div class="flex-1 overflow-auto bg-stone-50">${body}</div>
        </div>
      </div>
    </div>`;
}

// Pull the version list + current model body for the dialog. Best-effort — a
// failed leg leaves the previous content rather than blanking the dialog.
async function refreshModelInspect() {
  const [status, content] = await Promise.allSettled([
    api("/v1/workflow/model/status"),
    api("/v1/workflow/model/content"),
  ]);
  if (status.status === "fulfilled") state.modelStatus = status.value;
  if (content.status === "fulfilled") state.modelContent = content.value.content || "";
  render();
}

async function openModelInspect() {
  state.modelInspectOpen = true; state.modelBusy = false;
  state.modelStatus = null; state.modelContent = null;
  render();
  await refreshModelInspect();
}

function closeModelInspect() { state.modelInspectOpen = false; render(); }

// Re-pull the latest model from the current version's stored link, then rebuild
// this workflow. Disabled in the UI when there is no link to pull from.
async function reloadWorkflowModel() {
  if (state.modelBusy) return;
  state.modelBusy = true; render();
  try {
    await api("/v1/workflow/model/reload", { method: "POST", body: "{}" });
    state.modelMsg = { ok: true, text: "Reloaded the latest model from the source link — rebuilt this workflow." };
    await refreshModelInspect();
    await ensureMe();
    onHashChange();
  } catch (e) {
    state.modelMsg = { ok: false, text: (e && e.message) ? e.message : "Reload failed." };
  } finally {
    state.modelBusy = false; render();
    setTimeout(() => { state.modelMsg = null; render(); }, 3000);
  }
}

// Restore a stored version: re-applies it as a NEW current version + rebuilds.
async function restoreWorkflowVersion(versionId) {
  if (state.modelBusy || !versionId) return;
  state.modelBusy = true; render();
  try {
    await api("/v1/workflow/model/restore", { method: "POST", body: JSON.stringify({ versionId }) });
    state.modelMsg = { ok: true, text: "Restored that version — rebuilt this workflow." };
    await refreshModelInspect();
    await ensureMe();
    onHashChange();
  } catch (e) {
    state.modelMsg = { ok: false, text: (e && e.message) ? e.message : "Restore failed." };
  } finally {
    state.modelBusy = false; render();
    setTimeout(() => { state.modelMsg = null; render(); }, 3000);
  }
}

function bindModelInspect() {
  document.getElementById("btn-model-inspect")?.addEventListener("click", openModelInspect);
  document.getElementById("model-inspect-close")?.addEventListener("click", closeModelInspect);
  document.getElementById("model-inspect-backdrop")?.addEventListener("click", (e) => { if (e.target && e.target.id === "model-inspect-backdrop") closeModelInspect(); });
  document.getElementById("btn-model-reload")?.addEventListener("click", reloadWorkflowModel);
  // Replace hands off to the Set-model dialog (change link / upload / paste), so
  // close Inspect rather than stacking the two modals.
  document.getElementById("btn-model-replace")?.addEventListener("click", () => { state.modelInspectOpen = false; state.projModelOpen = true; state.projModelErr = null; render(); });
  document.querySelectorAll(".model-restore-btn").forEach((btn) => btn.addEventListener("click", () => restoreWorkflowVersion(btn.getAttribute("data-restore-id"))));
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
      <div class="mt-1 text-xs opacity-80">The event registry couldn't be built from the current model. Set a valid Qlerify model (⚙ Set model) and this banner clears.</div>
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

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function parseHash() {
  const h = location.hash || "";
  let m;
  if (h.startsWith("#login")) return { view: "login" };
  if (h.startsWith("#admin")) return { view: "admin" };
  if (h.startsWith("#org")) return { view: "org" };
  if ((m = h.match(/^#bc\/(.+)$/))) return { view: "bc", bc: decodeURIComponent(m[1]) };
  if (h.startsWith("#bcs")) return { view: "bcs" };
  if ((m = h.match(/^#demand\/([\w-]+)/))) return { view: "detail", demandId: m[1] };
  return { view: "dashboard" };
}

function navigate(hash) {
  if (location.hash === hash) {
    // hash unchanged — manually trigger reload
    onHashChange();
  } else {
    location.hash = hash;
  }
}

let dashboardTimer = null;

async function onHashChange() {
  const r = parseHash();
  state.view = r.view;
  state.demandId = r.demandId ?? null;
  state.bc = r.bc ?? null;
  state.bcBusy = false; // never carry a stuck busy-flag across navigation

  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }

  if (r.view === "login") { render(); return; }
  await ensureMe(); // load the tenant context for the top bar (best-effort)
  // If a 401 during ensureMe() cleared the session and redirected us, render the
  // login screen now instead of flashing a frame of header-less content.
  if (location.hash === "#login") { state.view = "login"; render(); return; }

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

  // A workflow that exists but has no model yet → the data plane throws
  // MODEL_NOT_LOADED. Catch it and show the "set this workflow's model" prompt
  // instead of a broken view.
  try {
    if (r.view === "detail") {
      await loadDetail();
    } else if (r.view === "admin") {
      await loadAdmin();
    } else if (r.view === "bcs") {
      await loadExplorer();
    } else if (r.view === "bc") {
      await loadBc(r.bc);
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
    if (isNoModelErr(e)) { state.view = "no-model"; render(); return; }
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
  const [demands, events] = await Promise.all([api("/sim/demands"), api("/sim/events"), loadRegistryStatus(), loadMeta()]);
  state.demands = demands;
  state.events = events;
  render();
}

// Model-derived UI labels — fetched once and reused; failures keep the defaults.
async function loadMeta() {
  try {
    const meta = await api("/sim/meta");
    state.meta = meta;
    document.title = `${meta.title} — Live`;
  } catch { /* keep defaults */ }
}

async function createDemand() {
  if (state.busy) return;
  state.busy = true; render();
  try {
    const d = await api("/sim/demands", { method: "POST", body: "{}" });
    await loadDashboard();
    // Auto-navigate into the new demand's detail view.
    navigate(`#demand/${d.id}`);
  } catch (e) {
    alert(e.message);
  } finally {
    state.busy = false; render();
  }
}

async function deleteDemand(demandId, ev) {
  ev.stopPropagation();
  if (!confirm("Remove this item and all its data?")) return;
  state.busy = true; render();
  try {
    await api("/sim/delete", { method: "POST", body: JSON.stringify({ demandId }) });
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
    <tr class="cursor-pointer hover:bg-amber-50 transition-colors" data-go="#demand/${d.id}">
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

function dashboardView() {
  const m = state.meta;
  const cols = genericColumns(state.demands);
  const rows = state.demands.map((d) => dashboardRow(d, cols)).join("");
  const empty = state.demands.length === 0;
  const plural = prettyEntity(m.rootAggregatePlural), singular = prettyEntity(m.rootAggregate);
  const headerCells = cols.map((c) => `<th class="px-4 py-2 font-medium">${escapeHtml(c)}</th>`).join("");
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(m.title)} — ${escapeHtml(plural)}</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">All ${escapeHtml(plural.toLowerCase())} in flight</div>
        </div>
        ${workflowModelControls()}
        <button id="btn-new-demand" ${state.busy ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">+ New ${escapeHtml(singular.toLowerCase())}</button>
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
  bindWorkflowModel();
  bindModelInspect();
  document.getElementById("btn-new-demand")?.addEventListener("click", createDemand);
  document.querySelectorAll("[data-go]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.go));
  });
  document.querySelectorAll("[data-delete]").forEach((el) => {
    el.addEventListener("click", (ev) => deleteDemand(el.dataset.delete, ev));
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
  if (workflowId && workflowId !== (state.me?.workflowId || "")) {
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
    <button data-ex-go="${r.workflowId}|${r.demandId}" class="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50">
      <span class="inline-block w-2 h-2 rounded-full ${late ? "bg-rose-500" : "bg-amber-400"} shrink-0"></span>
      <div class="flex-1 min-w-0"><div class="text-sm text-stone-800 truncate">${escapeHtml(r.workflowName)} · ${escapeHtml(r.demandId.slice(0, 12))}…</div><div class="text-[11px] text-stone-500">${sub}</div></div>
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
    <button data-ex-go="${x.workflowId}|${x.demandId}" class="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-amber-50">
      <span class="inline-block w-2 h-2 rounded-full ${dot} shrink-0"></span>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-stone-800 truncate"><span class="font-medium">${escapeHtml(x.title)}</span> — ${escapeHtml(x.detail)}</div>
        <div class="text-[11px] text-stone-500 truncate">${escapeHtml(x.workflowName)} · ${escapeHtml(x.demandId.slice(0, 12))}…</div>
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

function orgView() {
  const o = state.org;
  const head = (right) => `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Qlerify Live — Portfolio</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">Portfolio overview</div>
          ${o && !o.error ? `<div class="text-xs text-stone-500 mt-0.5">${o.northStar.workflowCount} workflow type${o.northStar.workflowCount === 1 ? "" : "s"} · ${o.northStar.activeInstances} active · ${o.northStar.modelledCount} modelled</div>` : ""}
        </div>
        ${right}
      </div>
    </header>`;
  const assistantBtn = `<button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>`;

  if (!o || o.error) {
    return head(assistantBtn) + `<main class="flex-1 p-6"><div class="text-sm ${o && o.error ? "text-rose-600" : "text-stone-400"}">${o && o.error ? escapeHtml(o.error) : "Loading portfolio…"}</div></main>` + orgMapDialog();
  }
  const ns = o.northStar;
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
      <div class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold mb-2">Workflow types</div>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">${o.workflows.map(orgCard).join("")}</div>
    </section>`;
  const feeds = `
    <section class="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
      ${panelShell("Exceptions", "Cross-portfolio attention queue", o.exceptions.length ? `<div class="-mx-4 -mb-4 divide-y divide-stone-100">${o.exceptions.map(orgExceptionRow).join("")}</div>` : `<div class="text-sm text-stone-400">Nothing needs attention. 🎉</div>`)}
      ${panelShell("Bottlenecks", "Where work is waiting (by step)", o.bottlenecks.length ? `<div class="-mx-4 -mb-4 divide-y divide-stone-100">${o.bottlenecks.map(orgBottleneckRow).join("")}</div>` : `<div class="text-sm text-stone-400">No active work in flight.</div>`)}
    </section>`;
  return head(right) + `
    <main class="flex-1 overflow-auto p-6">
      ${band}
      <div class="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-3">
        ${orgTimelinessPanel(o)}
        ${orgValueAtRiskPanel(o)}
      </div>
      ${grid}
      ${feeds}
      <div class="mt-6">${orgFreshnessPanel(o)}</div>
    </main>
    <footer class="px-6 py-3 text-xs text-stone-500 border-t border-stone-200 bg-stone-50">
      <span>Organisation portfolio · computed live from the event log across all workflows.</span>
      <span class="mx-2">·</span><span>updated ${escapeHtml(new Date(o.generatedAt).toLocaleTimeString())}</span>
    </footer>` + orgMapDialog();
}

function bindOrg() {
  document.querySelectorAll("[data-wf-go]").forEach((el) => el.addEventListener("click", () => orgGotoWorkflow(el.getAttribute("data-wf-go"), "#")));
  document.querySelectorAll("[data-bn-go]").forEach((el) => el.addEventListener("click", () => orgGotoWorkflow(el.getAttribute("data-bn-go"), "#")));
  document.querySelectorAll("[data-ex-go]").forEach((el) => el.addEventListener("click", () => {
    const [wf, demand] = (el.getAttribute("data-ex-go") || "").split("|");
    orgGotoWorkflow(wf, `#demand/${demand}`);
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

// ---------------------------------------------------------------------------
// Per-BC adapter workbench (Part 2.3, Slice 1) — read/projection over existing
// substrate; zero AI / credentials / dynamic code (that is Slice 2).
// ---------------------------------------------------------------------------

async function loadBcList() {
  await loadMeta();
  try { state.bcList = await api("/api/bc"); } catch { state.bcList = []; }
  render();
}

async function loadBc(bc) {
  await loadMeta();
  state.bcVerify = null; state.bcTest = null; state.bcRaw = null; state.bcCode = null;
  try { state.bcData = await api("/api/bc/" + encodeURIComponent(bc)); }
  catch (e) { state.bcData = { error: e.message, name: bc }; }
  // The workbench is one stacked page, so load the adapter code up front.
  const adapter = (state.bcData && state.bcData.adapters || [])[0];
  if (adapter) {
    try { state.bcCode = await api(`/api/adapters/${encodeURIComponent(adapter.id)}/code`); }
    catch { state.bcCode = { exists: false, source: "", hasKey: false }; }
  }
  render();
}

async function loadBcRaw() {
  state.bcBusy = true; render();
  try { state.bcRaw = await api(`/api/bc/${encodeURIComponent(state.bc)}/raw?limit=100`); }
  catch { state.bcRaw = { tableMissing: true, entity: null, rows: [] }; }
  finally { state.bcBusy = false; render(); }
}

function bcHeader(title, subtitle, back) {
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-4">
        ${back ? `<button data-go="${back}" class="text-stone-400 hover:text-stone-700 text-lg leading-none" title="Back">←</button>` : ""}
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(subtitle)}</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">${escapeHtml(title)}</div>
        </div>
        <button data-go="#" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50">Dashboard</button>
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>`;
}

// ===========================================================================
// Systems explorer (#bcs) — a three-pane data console:
//   Systems (bounded contexts) | Tables (entities) | Items (gen_ rows)
// + a Filters panel and a Configure Adapter sidebar (chat builder: later).
// Backed by /api/bc, /api/bc/:bc, /api/bc/:bc/raw — no new backend.
// ===========================================================================

function expState() {
  if (!state.exp) state.exp = { systems: [], system: null, entities: [], valueObjects: [], entity: null, items: [], adapters: [], tableSearch: "", filters: [], page: 0, sidebarOpen: false, sysCollapsed: false, tablesCollapsed: false, busy: false, tableMissing: false };
  return state.exp;
}

async function loadExplorer() {
  const e = expState();
  try { e.systems = await api("/api/bc"); } catch (_err) { e.systems = []; }
  const cur = e.system && e.systems.find((s) => s.name === e.system);
  if (e.systems[0]) { await selectExpSystem(cur ? e.system : e.systems[0].name); return; }
  render();
}

async function selectExpSystem(name) {
  const e = expState();
  e.system = name; e.entity = null; e.items = []; e.tableSearch = ""; e.filters = []; e.page = 0;
  try {
    const d = await api(`/api/bc/${encodeURIComponent(name)}`);
    e.entities = d.entities || [];
    e.valueObjects = d.valueObjects || [];
    e.adapters = d.adapters || [];
    const def = d.defaultEntity || (e.entities[0] && e.entities[0].name) || (e.valueObjects[0] && e.valueObjects[0].name);
    if (def) { await selectExpEntity(def); return; }
  } catch (_err) { e.entities = []; e.valueObjects = []; e.adapters = []; }
  render();
}

async function selectExpEntity(name) {
  const e = expState();
  e.entity = name; e.page = 0; e.filters = []; e.busy = true; render();
  try {
    const d = await api(`/api/bc/${encodeURIComponent(e.system)}/raw?entity=${encodeURIComponent(name)}&limit=300`);
    e.items = d.rows || [];
    e.tableMissing = !!d.tableMissing;
  } catch (_err) { e.items = []; e.tableMissing = true; }
  e.busy = false; render();
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
  e.sidebarOpen = false;
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
  }
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
      ${e.sidebarOpen ? expAdapterSidebar(e) : ""}
    </div>`;
}

function expSystemsCol(e) {
  if (e.sysCollapsed) {
    return `<div class="w-9 shrink-0 border-r border-stone-200 bg-white flex flex-col items-center pt-3"><button id="exp-sys-expand" class="text-stone-400 hover:text-stone-700" title="Show systems">›</button></div>`;
  }
  const items = (e.systems || []).map((s) =>
    `<button data-exp-sys="${escapeHtml(s.name)}" class="w-full text-left px-4 py-2 text-sm hover:bg-stone-100 ${s.name === e.system ? "text-sky-700 font-semibold bg-sky-50" : "text-stone-700"}">${escapeHtml(s.name)}</button>`).join("");
  return `
    <div class="w-56 shrink-0 border-r border-stone-200 bg-white flex flex-col">
      <div class="px-4 py-3 flex items-center justify-between border-b border-stone-100">
        <span class="font-semibold text-stone-900">Systems</span>
        <button id="exp-sys-collapse" class="text-stone-400 hover:text-stone-700" title="Collapse">‹</button>
      </div>
      <div class="overflow-y-auto py-1 flex-1">${items || '<div class="px-4 py-3 text-sm text-stone-400">No systems</div>'}</div>
    </div>`;
}

function expTablesCol(e) {
  if (e.tablesCollapsed) {
    return `<div class="w-9 shrink-0 border-r border-stone-200 bg-white flex flex-col items-center pt-3"><button id="exp-tables-expand" class="text-stone-400 hover:text-stone-700" title="Show tables">›</button></div>`;
  }
  const entities = e.entities || [];
  const vos = e.valueObjects || [];
  const total = entities.length + vos.length;
  const q = (e.tableSearch || "").toLowerCase();
  const match = (t) => !q || t.name.toLowerCase().includes(q);
  const row = (t) =>
    `<button data-exp-entity="${escapeHtml(t.name)}" class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-stone-100 ${t.name === e.entity ? "bg-sky-50" : ""}">
      <span class="w-3 h-3 rounded-full border ${t.name === e.entity ? "border-sky-500 bg-sky-500" : "border-stone-300"}"></span>
      <span class="flex-1 ${t.name === e.entity ? "text-sky-700 font-medium" : "text-stone-700"}">${escapeHtml(t.name)}</span>
    </button>`;
  const ents = entities.filter(match);
  const vobs = vos.filter(match);
  const group = (label, list) => list.length
    ? `<div class="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-stone-400">${label}</div>${list.map(row).join("")}`
    : "";
  const body = (ents.length || vobs.length)
    ? `${group("Entities", ents)}${group("Value objects", vobs)}`
    : `<div class="px-4 py-3 text-sm text-stone-400">${total ? "No match" : "No tables"}</div>`;
  return `
    <div class="w-80 shrink-0 border-r border-stone-200 bg-white flex flex-col">
      <div class="px-4 py-3 border-b border-stone-100 flex items-center justify-between">
        <span class="font-semibold text-stone-900">Tables <span class="text-stone-400 font-normal">(${total})</span></span>
        <button id="exp-tables-collapse" class="text-stone-400 hover:text-stone-700" title="Collapse">‹</button>
      </div>
      <div class="px-3 py-2 border-b border-stone-100">
        <div class="relative">
          <input id="exp-table-search" value="${escapeHtml(e.tableSearch || "")}" placeholder="Find a table" class="w-full text-sm border border-stone-300 rounded-md pl-7 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400" />
          <span class="absolute left-2 top-1.5 text-stone-400 text-sm">🔍</span>
        </div>
      </div>
      <div class="overflow-y-auto py-1 flex-1">${body}</div>
    </div>`;
}

function expMain(e) {
  if (!e.system) return `<div class="flex-1 flex items-center justify-center text-stone-400 text-sm">Loading systems…</div>`;
  if (!e.entity) return `<div class="flex-1 flex items-center justify-center text-stone-400 text-sm">Select a table to explore its items.</div>`;
  const entity = (e.entities || []).find((t) => t.name === e.entity) || (e.valueObjects || []).find((t) => t.name === e.entity);
  const cols = entity && entity.fields && entity.fields.length
    ? entity.fields.map((f) => f.name)
    : (e.items[0] ? Object.keys(e.items[0]).filter((k) => k !== "_provenance") : ["id"]);
  const rows = applyExpFilters(e.items, e.filters);
  const PAGE = 25;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const page = Math.min(e.page, pages - 1);
  const pageRows = rows.slice(page * PAGE, page * PAGE + PAGE);
  const headerCells = cols.map((c) => `<th class="px-3 py-2 text-left text-[11px] font-semibold text-stone-600 whitespace-nowrap border-b border-stone-200">${escapeHtml(c)}</th>`).join("");
  const bodyRows = pageRows.map((r) => `<tr class="hover:bg-stone-50 border-b border-stone-100">
      <td class="px-3 py-2"><input type="checkbox" class="rounded border-stone-300" /></td>
      ${cols.map((c, ci) => {
        const val = r[c];
        const empty = val === null || val === undefined || val === "";
        const s = empty ? "" : String(val);
        const disp = empty ? '<span class="text-stone-300">—</span>' : escapeHtml(s.length > 44 ? s.slice(0, 44) + "…" : s);
        return `<td class="px-3 py-2 text-sm whitespace-nowrap ${ci === 0 ? "text-sky-700 font-medium mono text-xs" : "text-stone-700"}">${disp}</td>`;
      }).join("")}
    </tr>`).join("");
  return `
    <div class="flex-1 flex flex-col min-w-0 bg-white">
      <div class="px-6 py-4 flex items-center justify-between border-b border-stone-200">
        <div class="text-xl font-semibold text-stone-900">${escapeHtml(e.entity)}</div>
        <button id="exp-config-adapter" class="px-4 py-1.5 text-sm rounded-full border ${e.sidebarOpen ? "border-sky-400 bg-sky-50 text-sky-700" : "border-sky-300 bg-white text-sky-700 hover:bg-sky-50"} font-medium">Configure Adapter</button>
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
      <div class="flex-1 overflow-auto px-6 pb-6">
        ${e.busy ? '<div class="text-stone-400 text-sm py-10 text-center">Loading…</div>'
          : e.tableMissing ? `<div class="text-stone-400 text-sm py-10 text-center">No data yet for <b>${escapeHtml(e.entity)}</b>. Run the simulator or connect an adapter to populate it.</div>`
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
      <datalist id="exp-attr-list">${cols.map((c) => `<option value="${escapeHtml(c)}">`).join("")}</datalist>
      ${filterRows}
      <button id="exp-add-filter" class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 mb-1">Add filter</button>
      <div class="flex items-center gap-3 mt-1">
        <button id="exp-run" class="px-5 py-1.5 text-sm rounded-full bg-amber-400 hover:bg-amber-500 text-stone-900 font-semibold">Run</button>
        <button id="exp-reset" class="text-sm text-sky-700 hover:underline">Reset</button>
      </div>
    </details>`;
}

function expAdapterSidebar(e) {
  const adapters = e.adapters || [];
  const list = adapters.length
    ? adapters.map((a) => `<div class="rounded-md border border-stone-200 p-2.5"><div class="text-sm font-medium text-stone-800">${escapeHtml(a.id)}</div><div class="text-xs text-stone-500 mt-0.5">${escapeHtml(a.kind)} · ${escapeHtml(a.mode)} → ${escapeHtml(a.targetEntity)}</div></div>`).join("")
    : '<div class="text-sm text-stone-400">No adapter yet for this system.</div>';
  return `
    <div class="w-96 shrink-0 border-l border-stone-200 bg-white flex flex-col">
      <div class="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
        <span class="font-semibold text-stone-900">Configure Adapter</span>
        <button id="exp-sidebar-close" class="text-stone-400 hover:text-stone-700">✕</button>
      </div>
      <div class="p-4 overflow-y-auto flex-1 space-y-3">
        <div class="text-xs text-stone-500">System <b>${escapeHtml(e.system || "")}</b> → ${expKindOf(e, e.entity) === "valueObject" ? "value object" : "table"} <b>${escapeHtml(e.entity || "")}</b></div>
        ${list}
        <div class="rounded-lg border border-sky-200 bg-sky-50/60 p-4 text-center">
          <div class="text-2xl mb-1">✨</div>
          <div class="text-sm font-medium text-stone-800">Build a connector with AI</div>
          <div class="text-xs text-stone-500 mt-1">Describe any source — DynamoDB, a REST API, Postgres, a Google Sheet — and the assistant writes, tests, and runs a connector to fill this table.</div>
          <button id="exp-build-ai" class="w-full mt-3 px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 font-medium">Build connector with AI →</button>
        </div>
        <a href="#bc/${encodeURIComponent(e.system || "")}" class="block text-center text-sm text-sky-700 hover:underline">Open full adapter workbench →</a>
      </div>
    </div>`;
}

function bindExplorer() {
  document.getElementById("exp-sys-collapse")?.addEventListener("click", () => { expState().sysCollapsed = true; render(); });
  document.getElementById("exp-sys-expand")?.addEventListener("click", () => { expState().sysCollapsed = false; render(); });
  document.getElementById("exp-tables-collapse")?.addEventListener("click", () => { expState().tablesCollapsed = true; render(); });
  document.getElementById("exp-tables-expand")?.addEventListener("click", () => { expState().tablesCollapsed = false; render(); });
  document.querySelectorAll("[data-exp-sys]").forEach((el) => el.addEventListener("click", () => selectExpSystem(el.dataset.expSys)));
  document.querySelectorAll("[data-exp-entity]").forEach((el) => el.addEventListener("click", () => selectExpEntity(el.dataset.expEntity)));
  const search = document.getElementById("exp-table-search");
  if (search) search.addEventListener("input", (ev) => {
    expState().tableSearch = ev.target.value;
    render();
    const s = document.getElementById("exp-table-search");
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  });
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
  document.getElementById("exp-config-adapter")?.addEventListener("click", () => { const e = expState(); e.sidebarOpen = !e.sidebarOpen; render(); });
  document.getElementById("exp-sidebar-close")?.addEventListener("click", () => { expState().sidebarOpen = false; render(); });
  document.getElementById("exp-build-ai")?.addEventListener("click", openConnectorChat);
}

function bcListView() {
  const list = state.bcList || [];
  const cards = list.map((b) => `
    <button data-go="#bc/${encodeURIComponent(b.name)}" class="text-left rounded-lg border border-stone-200 bg-white hover:border-amber-300 hover:bg-amber-50 transition-colors p-4 flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <div class="font-semibold text-stone-900">${escapeHtml(b.name)}</div>
        ${provChip(b.provenance && b.provenance.mode)}
      </div>
      <div class="text-xs text-stone-500">${b.eventCount} events · ${b.entityCount} entities · ${b.adapterCount} adapter${b.adapterCount === 1 ? "" : "s"}</div>
      ${b.provenance && b.provenance.adapter ? `<div class="text-[11px] text-stone-400 mono">${escapeHtml(b.provenance.adapter)}</div>` : ""}
    </button>`).join("");
  return `
    ${bcHeader("Bounded contexts", "Each system, its adapter, and its live data", "#")}
    <main class="flex-1 overflow-auto p-6">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">${cards || `<div class="text-stone-400">No bounded contexts.</div>`}</div>
    </main>`;
}

// One titled section in the stacked workbench (replaces the old tabs).
function bcSection(title, body) {
  return `
    <section class="space-y-3">
      <div class="border-b border-stone-200 pb-1.5"><span class="text-sm font-semibold text-stone-700">${title}</span></div>
      ${body}
    </section>`;
}

function bcWorkbenchView() {
  const d = state.bcData;
  if (!d) return bcHeader("Loading…", "", "#bcs");
  if (d.error) return `${bcHeader(d.name || "Bounded context", "Adapter workbench", "#bcs")}<main class="p-6"><div class="text-rose-600">${escapeHtml(d.error)}</div></main>`;
  const adapter = (d.adapters || [])[0];
  const subBar = `
    <div class="px-6 py-2 border-b border-stone-200 bg-white flex items-center gap-2 text-sm text-stone-600">
      <span>data source</span> ${provChip(d.provenance && d.provenance.mode)}
      ${adapter ? `<span class="mono text-xs text-stone-400">${escapeHtml(adapter.id)}</span>` : `<span class="text-stone-400">no adapter</span>`}
    </div>`;
  // Stacked sections (no tabs). With no adapter, show one "Connect a system"
  // prompt + the model overview rather than the empty per-tab panels.
  const sections = adapter
    ? [
        bcSection("Connection", bcConnectionPanel(d, adapter)),
        bcSection("Adapter code", bcCodePanel(d, adapter)),
        bcSection("Test", bcTestPanel(d, adapter)),
        bcSection("Raw data", bcRawPanel(d, adapter)),
        bcSection("Overview", bcOverviewPanel(d)),
      ].join("")
    : `${bcNoAdapter(d)}${bcSection("Overview", bcOverviewPanel(d))}`;
  return `
    ${bcHeader(d.name, "Adapter workbench", "#bcs")}
    ${subBar}
    <main class="flex-1 overflow-auto p-6 space-y-8">${sections}</main>`;
}

function bcNoAdapter(d) {
  const entity = (d && d.defaultEntity) || "the root entity";
  return `
    <div class="max-w-xl rounded-lg border border-dashed border-stone-300 bg-white p-6 text-center">
      <div class="text-stone-400 text-4xl mb-2">🔌</div>
      <div class="text-stone-700 font-medium">No adapter for this system yet</div>
      <div class="text-sm text-stone-500 mt-1">Create one to pull <span class="mono">${escapeHtml(prettyEntity(String(entity)))}</span> records from the real source. It starts simulated; then configure the endpoint + credentials and let AI author the live connector.</div>
      <button id="bc-add-adapter" ${state.bcBusy ? "disabled" : ""} class="mt-4 px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50">Connect a system</button>
    </div>`;
}

function bcOverviewPanel(d) {
  const evRows = (d.events || []).map((e) => `
    <tr class="border-t border-stone-100">
      <td class="px-3 py-2 text-stone-700">${escapeHtml(e.name)}</td>
      <td class="px-3 py-2 text-stone-500">${escapeHtml(e.role || "")}</td>
      <td class="px-3 py-2 mono text-xs text-stone-500">${escapeHtml(prettyEntity(e.aggregateRoot || ""))}</td>
      <td class="px-3 py-2">${e.derived ? `<span class="text-amber-600 text-xs font-semibold">DERIVED</span>` : ""}</td>
    </tr>`).join("");
  const chips = (arr, cls) => (arr || []).map((x) => `<span class="inline-block px-2 py-1 mr-1 mb-1 rounded ${cls} text-xs">${escapeHtml(prettyEntity(x.name))}</span>`).join("") || `<span class="text-stone-400 text-sm">none</span>`;
  return `
    <div class="space-y-6 max-w-4xl">
      <section><div class="text-xs uppercase tracking-wide text-stone-500 font-semibold mb-2">Entities</div><div>${chips(d.entities, "bg-sky-50 text-sky-700")}</div></section>
      <section><div class="text-xs uppercase tracking-wide text-stone-500 font-semibold mb-2">Commands</div><div>${chips(d.commands, "bg-stone-100 text-stone-700")}</div></section>
      <section>
        <div class="text-xs uppercase tracking-wide text-stone-500 font-semibold mb-2">Events (${(d.events || []).length})</div>
        <div class="rounded-lg border border-stone-200 bg-white overflow-hidden"><table class="w-full text-sm"><tbody>${evRows}</tbody></table></div>
      </section>
    </div>`;
}

function bcConnectionPanel(d, adapter) {
  if (!adapter) return bcNoAdapter(d);
  const v = state.bcVerify;
  const status = v == null ? `<span class="text-stone-400">not checked</span>`
    : v.ok ? `<span class="text-emerald-700">● connected</span> <span class="text-stone-500">${escapeHtml(v.detail || "")}</span>`
    : `<span class="text-rose-600">● not connected</span> <span class="text-stone-500">${escapeHtml(v.detail || "")}</span>`;
  return `
    <div class="max-w-2xl space-y-4">
      <div class="rounded-lg border border-stone-200 bg-white p-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="font-medium text-stone-900">${escapeHtml(adapter.id)}</div>
            <div class="text-xs text-stone-500">kind: ${escapeHtml(adapter.kind)} · target: ${escapeHtml(prettyEntity(adapter.targetEntity))} · mode: ${escapeHtml(adapter.mode)}</div>
          </div>
          <button id="bc-verify" ${state.bcBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 shrink-0">Verify connection</button>
        </div>
        <div class="mt-3 text-sm">${status}${v && v.at ? `<span class="text-stone-400 text-xs ml-2">${new Date(v.at).toLocaleTimeString()}</span>` : ""}</div>
      </div>

      <div class="rounded-lg border border-stone-200 bg-white p-4 space-y-3">
        <div class="text-xs uppercase tracking-wide text-stone-500 font-semibold">Endpoint &amp; credentials</div>
        <label class="block text-xs text-stone-500">Endpoint URL
          <input id="bc-endpoint" type="text" placeholder="https://…/odata/PurchaseOrders" class="mt-1 w-full px-2 py-1.5 text-sm rounded border border-stone-300" />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="block text-xs text-stone-500">Credential key (env var)
            <input id="bc-credref" type="text" placeholder="SAP_API_TOKEN" class="mt-1 w-full px-2 py-1.5 text-sm rounded border border-stone-300 mono" />
          </label>
          <label class="block text-xs text-stone-500">Secret
            <input id="bc-secret" type="password" placeholder="••••••••" autocomplete="off" class="mt-1 w-full px-2 py-1.5 text-sm rounded border border-stone-300" />
          </label>
        </div>
        <div class="flex gap-2">
          <button id="bc-config-save" ${state.bcBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Save endpoint</button>
          <button id="bc-cred-save" ${state.bcBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Set credential</button>
        </div>
        <div class="text-[11px] text-stone-400">The secret is never echoed, written to disk, or sent to chat — only the key name is remembered (dev: kept in process env; encrypted-at-rest store is the next increment). The AI-authored adapter reads it as <span class="mono">ctx.secret</span>.</div>
      </div>

      <div class="rounded-lg border border-rose-200 bg-rose-50 p-4 space-y-2">
        <div class="text-xs uppercase tracking-wide text-rose-600 font-semibold">Danger zone</div>
        <div class="flex gap-2 flex-wrap">
          <button id="bc-reset" ${state.bcBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-rose-300 bg-white text-rose-700 hover:bg-rose-100 disabled:opacity-50">Reset adapter</button>
          <button id="bc-remove" ${state.bcBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-rose-300 bg-white text-rose-700 hover:bg-rose-100 disabled:opacity-50">Remove adapter</button>
        </div>
        <div class="text-[11px] text-rose-700/80"><b>Reset</b> wipes the AI-authored code + stored credentials back to a clean simulated draft (keeps the adapter, so you can build it from scratch). <b>Remove</b> deletes it entirely.</div>
      </div>
    </div>`;
}

function bcCodePanel(d, adapter) {
  if (!adapter) return bcNoAdapter(d);
  const c = state.bcCode;
  const hasKey = c ? c.hasKey : false;
  const src = c && c.exists ? c.source : "";
  const genLabel = c && c.exists ? "Regenerate with AI" : "Generate with AI";
  return `
    <div class="max-w-4xl space-y-3">
      <div class="flex items-center gap-3 flex-wrap">
        <button id="bc-generate" ${(!hasKey || state.bcBusy) ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50">${genLabel}</button>
        <span class="text-xs text-stone-400">${hasKey
          ? "AI writes fetchRows(ctx) from the model attributes; it is shown here and only runs when you Test it (stop-and-show)."
          : "set ANTHROPIC_API_KEY in .env to let AI author the adapter live."}</span>
      </div>
      ${c && c.bodyPath ? `<div class="text-[11px] mono text-stone-400">${escapeHtml(c.bodyPath)}</div>` : ""}
      ${src
        ? `<pre class="rounded-lg border border-stone-200 bg-stone-50 p-3 text-[11px] leading-relaxed overflow-auto mono text-stone-800" style="max-height:60vh">${escapeHtml(src)}</pre>`
        : `<div class="text-stone-400 text-sm">No adapter body yet${hasKey ? " — click Generate to have AI write one against the PurchaseOrder schema." : "."}</div>`}
    </div>`;
}

function bcTestPanel(d, adapter) {
  if (!adapter) return bcNoAdapter(d);
  const t = state.bcTest;
  let result = "";
  if (t && !t.error) {
    const checklist = ((t.diff && t.diff.requiredStatus) || []).map((r) => `
      <span class="inline-flex items-center gap-1 px-2 py-1 mr-1 mb-1 rounded text-xs ${r.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}">${r.ok ? "✓" : "✗"} ${escapeHtml(r.field)}</span>`).join("");
    const cols = t.rows && t.rows.length ? Object.keys(t.rows[0]) : [];
    const head = cols.map((c) => `<th class="px-2 py-1 text-left font-medium text-stone-500">${escapeHtml(c)}</th>`).join("");
    const body = (t.rows || []).map((row) => `<tr class="border-t border-stone-100">${cols.map((c) => `<td class="px-2 py-1 text-stone-700">${escapeHtml(String(row[c] ?? ""))}</td>`).join("")}</tr>`).join("");
    const extra = (t.diff && t.diff.extraFields) || [];
    result = `
      <div class="mt-4 space-y-3">
        <div class="text-sm">${t.diff && t.diff.ok ? `<span class="text-emerald-700 font-medium">✓ matches the model</span>` : `<span class="text-rose-600 font-medium">✗ mismatch</span>`} <span class="text-stone-500">${t.count} row(s), nothing written</span></div>
        <div>${checklist}</div>
        ${extra.length ? `<div class="text-xs text-amber-700">extra unmapped fields: ${extra.map(escapeHtml).join(", ")}</div>` : ""}
        <div class="rounded-lg border border-stone-200 bg-white overflow-auto"><table class="text-xs w-full"><thead class="bg-stone-50"><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      </div>`;
  } else if (t && t.error) {
    result = `<div class="mt-4 text-rose-600 text-sm">${escapeHtml(t.error)}</div>`;
  }
  return `
    <div class="max-w-4xl">
      <div class="flex items-center gap-3 flex-wrap">
        <button id="bc-test" ${state.bcBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50">Test adapter (dry run)</button>
        <button id="bc-ingest" ${state.bcBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Ingest for real →</button>
        <span class="text-xs text-stone-400">dry run pulls + grades against the model without writing; ingest lands rows in the projection store</span>
      </div>
      ${result}
    </div>`;
}

function bcRawPanel(d, adapter) {
  const r = state.bcRaw;
  let body = `<div class="text-stone-400 text-sm">Click <b>Load raw rows</b> to read the ingestion table.</div>`;
  if (r) {
    if (r.tableMissing) body = `<div class="text-stone-400 text-sm">No ingestion table for <span class="mono">${escapeHtml(prettyEntity(r.entity || d.defaultEntity || ""))}</span> yet — run an ingest from the Test tab.</div>`;
    else if (!r.rows.length) body = `<div class="text-stone-400 text-sm">Table <span class="mono">gen_${escapeHtml(r.entity)}</span> is empty.</div>`;
    else {
      const cols = Object.keys(r.rows[0]);
      const head = cols.map((c) => `<th class="px-2 py-1 text-left font-medium text-stone-500">${escapeHtml(c)}</th>`).join("");
      const rowsHtml = r.rows.map((row) => `<tr class="border-t border-stone-100">${cols.map((c) => c === "_provenance" ? `<td class="px-2 py-1">${provChip(row[c])}</td>` : `<td class="px-2 py-1 text-stone-700">${escapeHtml(String(row[c] ?? ""))}</td>`).join("")}</tr>`).join("");
      body = `<div class="rounded-lg border border-stone-200 bg-white overflow-auto"><table class="text-xs w-full"><thead class="bg-stone-50"><tr>${head}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
    }
  }
  return `
    <div class="max-w-5xl space-y-3">
      <div class="flex items-center gap-3">
        <button id="bc-raw" ${state.bcBusy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50">Load raw rows</button>
        <span class="text-xs text-stone-400">verbatim <span class="mono">gen_${escapeHtml(d.defaultEntity || "")}</span> projection rows, including provenance</span>
      </div>
      ${body}
    </div>`;
}

function bindBcList() {
  document.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => navigate(el.dataset.go)));
}

function bindBcWorkbench() {
  document.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => navigate(el.dataset.go)));
  const adapter = (state.bcData && state.bcData.adapters || [])[0];
  document.getElementById("bc-add-adapter")?.addEventListener("click", async () => {
    state.bcBusy = true; render();
    try { await api(`/api/bc/${encodeURIComponent(state.bc)}/adapter`, { method: "POST", body: "{}" }); await loadBc(state.bc); }
    catch (e) { alert("Could not connect a system: " + e.message); }
    finally { state.bcBusy = false; render(); }
  });
  document.getElementById("bc-reset")?.addEventListener("click", async () => {
    if (!adapter) return;
    if (!confirm("Reset this adapter to a clean simulated draft? Its AI-authored code and stored credentials will be deleted.")) return;
    state.bcBusy = true; render();
    try { await api(`/api/adapters/${encodeURIComponent(adapter.id)}/reset`, { method: "POST", body: "{}" }); await loadBc(state.bc); }
    catch (e) { alert("Reset failed: " + e.message); }
    finally { state.bcBusy = false; render(); }
  });
  document.getElementById("bc-remove")?.addEventListener("click", async () => {
    if (!adapter) return;
    if (!confirm("Remove this adapter entirely? This deletes its code, credentials, and configuration.")) return;
    state.bcBusy = true; render();
    try { await api(`/api/adapters/${encodeURIComponent(adapter.id)}`, { method: "DELETE" }); await loadBc(state.bc); }
    catch (e) { alert("Remove failed: " + e.message); }
    finally { state.bcBusy = false; render(); }
  });
  document.getElementById("bc-generate")?.addEventListener("click", async () => {
    if (!adapter) return;
    state.bcBusy = true; render();
    try { await api(`/api/adapters/${encodeURIComponent(adapter.id)}/code/generate`, { method: "POST", body: "{}" }); await loadBc(state.bc); }
    catch (e) { alert("Generate failed: " + e.message); }
    finally { state.bcBusy = false; render(); }
  });
  document.getElementById("bc-config-save")?.addEventListener("click", async () => {
    if (!adapter) return;
    const endpoint = document.getElementById("bc-endpoint")?.value || "";
    const credentialsRef = document.getElementById("bc-credref")?.value || "";
    state.bcBusy = true; render();
    try { await api(`/api/bc/${encodeURIComponent(state.bc)}/adapter/${encodeURIComponent(adapter.id)}/config`, { method: "PUT", body: JSON.stringify({ endpoint, credentialsRef }) }); }
    catch (e) { alert("Save failed: " + e.message); }
    finally { state.bcBusy = false; render(); }
  });
  document.getElementById("bc-cred-save")?.addEventListener("click", async () => {
    if (!adapter) return;
    const credentialsRef = document.getElementById("bc-credref")?.value || "";
    const secret = document.getElementById("bc-secret")?.value || "";
    if (!credentialsRef || !secret) { alert("Enter a credential key and secret."); return; }
    state.bcBusy = true; render();
    try { await api(`/api/bc/${encodeURIComponent(state.bc)}/adapter/${encodeURIComponent(adapter.id)}/credential`, { method: "PUT", body: JSON.stringify({ credentialsRef, secret }) }); }
    catch (e) { alert("Failed: " + e.message); }
    finally { state.bcBusy = false; render(); }
  });
  document.getElementById("bc-verify")?.addEventListener("click", async () => {
    if (!adapter) return;
    state.bcBusy = true; render();
    try { state.bcVerify = await api(`/api/bc/${encodeURIComponent(state.bc)}/adapter/${encodeURIComponent(adapter.id)}/verify`, { method: "POST", body: "{}" }); }
    catch (e) { state.bcVerify = { ok: false, detail: e.message }; }
    finally { state.bcBusy = false; render(); }
  });
  document.getElementById("bc-test")?.addEventListener("click", async () => {
    if (!adapter) return;
    state.bcBusy = true; render();
    try { state.bcTest = await api(`/api/bc/${encodeURIComponent(state.bc)}/adapter/${encodeURIComponent(adapter.id)}/test`, { method: "POST", body: JSON.stringify({ limit: 5 }) }); }
    catch (e) { state.bcTest = { error: e.message }; }
    finally { state.bcBusy = false; render(); }
  });
  document.getElementById("bc-ingest")?.addEventListener("click", async () => {
    if (!adapter) return;
    state.bcBusy = true; render();
    try { await api(`/api/adapters/${encodeURIComponent(adapter.id)}/pull`, { method: "POST", body: JSON.stringify({ limit: 5 }) }); await loadBcRaw(); }
    catch (e) { alert("Ingest failed: " + e.message); state.bcBusy = false; render(); }
  });
  document.getElementById("bc-raw")?.addEventListener("click", loadBcRaw);
}

// ---------------------------------------------------------------------------
// Detail view (current 7-panel demo)
// ---------------------------------------------------------------------------

async function loadDetail() {
  await loadMeta();
  // Per-run detail from the model-generic simulator.
  const [instance, events, cur] = await Promise.all([
    api("/sim/instance/" + encodeURIComponent(state.demandId)),
    api("/sim/events"),
    api("/sim/current-step?demandId=" + encodeURIComponent(state.demandId)),
    loadRegistryStatus(),
  ]);
  // Keep the pre-step instance so the detail view can mark what this step
  // changed. Only diff within the same run — switching runs starts clean.
  state.prevInstance = state.instance && state.instance.instanceId === instance.instanceId ? state.instance : null;
  state.instance = instance;
  state.events = events;
  // newest-first so lastEventCaption() / businessByStep read the latest first.
  state.log = (instance.events || []).slice().reverse();
  state.currentIndex = cur.index;
  render();
}

async function doNext() {
  if (state.busy) return;
  state.busy = true; render();
  try {
    await api("/sim/next", {
      method: "POST",
      body: JSON.stringify({ demandId: state.demandId }),
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
  state.busy = true; render();
  try {
    await api("/sim/run-all", {
      method: "POST",
      body: JSON.stringify({ demandId: state.demandId }),
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
  if (!confirm("Reset this demand and start over?")) return;
  state.busy = true; render();
  try {
    await api("/sim/reset", { method: "POST", body: JSON.stringify({ demandId: state.demandId }) });
    // demand was deleted; go back to dashboard
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

  // Main spine: start at the source that begins the longest path, then always
  // follow the successor with the most depth remaining, to the end.
  const spine = new Set();
  const sources = events.filter((e) => preds(e.ref).length === 0).map((e) => e.ref);
  if (sources.length) {
    let cur = sources.reduce((a, b) => (height(b) > height(a) ? b : a));
    while (cur) {
      spine.add(cur);
      const ss = succ.get(cur) || [];
      if (!ss.length) break;
      cur = ss.reduce((a, b) => (height(b) > height(a) ? b : a));
    }
  }

  // Lanes: spine on lane 0; everything else takes the lowest free lane in its
  // column, preferring to inherit a non-spine predecessor's lane so a branch
  // reads as one straight horizontal run rather than zig-zagging.
  const lane = new Map();
  const occupied = new Set(); // "lane,col"
  for (const ref of spine) { lane.set(ref, 0); occupied.add(`0,${col(ref)}`); }
  const others = events
    .filter((e) => !spine.has(e.ref))
    .sort((a, b) => col(a.ref) - col(b.ref) || byRef.get(a.ref).idx - byRef.get(b.ref).idx);
  for (const e of others) {
    const c = col(e.ref);
    let L = null;
    for (const p of preds(e.ref)) {
      const pl = lane.get(p);
      if (!spine.has(p) && pl != null && !occupied.has(`${pl},${c}`)) { L = pl; break; }
    }
    if (L == null) { L = 1; while (occupied.has(`${L},${c}`)) L++; }
    lane.set(e.ref, L);
    occupied.add(`${L},${c}`);
  }

  const place = new Map(events.map((e) => [e.ref, { col: col(e.ref), lane: lane.get(e.ref), idx: byRef.get(e.ref).idx }]));
  const cols = Math.max(...events.map((e) => col(e.ref))) + 1;
  const lanes = Math.max(...events.map((e) => lane.get(e.ref))) + 1;
  const edges = [];
  for (const e of events) for (const p of preds(e.ref)) edges.push({ from: p, to: e.ref });
  return { cols, lanes, place, edges };
}

// Card + grid geometry (px). Cards are absolutely positioned so the connector
// SVG underneath can use exact coordinates; the column/row pitch leaves a gutter
// for the connectors between cards.
const FLOW = { cardW: 176, cardH: 104, colPitch: 224, rowPitch: 148 };

function timeline() {
  const total = state.events.length;
  const pct = total ? (state.currentIndex / total) * 100 : 0;
  const biz = businessByStep();
  let prevBizIso = null;

  const layout = computeFlowLayout(state.events);
  const { cardW, cardH, colPitch, rowPitch } = FLOW;
  const W = (layout.cols - 1) * colPitch + cardW;
  const H = (layout.lanes - 1) * rowPitch + cardH;

  // Per-lane "frontier" = the most recently fired event on each lane (its
  // highest linear step index). Stepping interleaves the lanes, so each branch
  // has advanced to a different point: any fired event *before* its lane's
  // frontier is that branch's past and gets a green tint; the frontier itself
  // (the branch's latest) and not-yet-fired events do not.
  const laneFrontier = new Map();
  state.events.forEach((e, i) => {
    if (i >= state.currentIndex) return;
    const lane = layout.place.get(e.ref)?.lane ?? 0;
    const cur = laneFrontier.get(lane);
    if (cur == null || i > cur) laneFrontier.set(lane, i);
  });

  // Iterate in declared (linear) order so `data-step`, the fired/current logic,
  // and the business-date gap accumulation all stay tied to the step sequence;
  // each card is then *positioned* by its lane/column placement.
  const cards = state.events.map((e, i) => {
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    const fired = i < state.currentIndex;
    const isCurrent = i === state.currentIndex - 1;
    const phaseBorder = PHASE_TONE[e.phase] || "border-stone-300";
    const ringClass = isCurrent ? "ring-2 ring-amber-400" : "";
    // Already-completed on this branch (fired and before the lane's frontier).
    const isPast = fired && i < (laneFrontier.get(pos.lane) ?? -1);

    const bizIso = biz.get(e.ref);
    const bizLabel = fired ? fmtBizDate(bizIso) : null;
    const gapMin = fired && prevBizIso && bizIso ? minutesBetween(prevBizIso, bizIso) : null;
    if (fired && bizIso) prevBizIso = bizIso;

    // Highlight long gaps (≥10 days) in amber so the supplier-slip moment pops.
    const gapTone = gapMin != null && gapMin >= 10 * 1440 ? "text-amber-700 font-semibold" : "text-stone-500";

    // Each step's source mode = its bounded context's configured mode.
    const provMode = provModeForBC(e.boundedContext);

    return `
      <div data-step="${i}" class="absolute rounded-md border ${isPast ? "border-emerald-200" : phaseBorder} ${ringClass} ${isPast ? "bg-emerald-50" : "bg-white"} px-3 py-2 ${fired ? "" : "opacity-60"} flex flex-col overflow-hidden"
           style="left:${pos.col * colPitch}px; top:${pos.lane * rowPitch}px; width:${cardW}px; height:${cardH}px; ${provHatch(provMode)}">
        <div class="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
          <span class="truncate">${i+1}. ${e.boundedContext}</span>
          <span class="flex items-center gap-1 shrink-0">
            ${e.derived ? `<span class="text-amber-600 font-semibold">DERIVED</span>` : ""}
            ${provChip(provMode)}
          </span>
        </div>
        <div class="text-[12px] font-medium leading-tight text-stone-800">${e.name}</div>
        <div class="text-[10px] text-stone-500 mt-1">${e.role}</div>
        ${fired ? `
          <div class="mt-auto pt-1.5 border-t border-stone-100 flex items-baseline justify-between text-[10px]">
            <span class="text-stone-700 font-medium mono">${bizLabel ?? "—"}</span>
            ${gapMin != null && gapMin > 0 ? `<span class="${gapTone}">${fmtGap(gapMin)}</span>` : ""}
          </div>
        ` : ""}
      </div>
    `;
  }).join("");

  // Connectors: a smooth S-curve from each predecessor's right edge to the
  // event's left edge. Edges whose target has fired are drawn dark; pending
  // edges stay faint, so the lit path tracks how far the run has progressed.
  const paths = layout.edges.map(({ from, to }) => {
    const a = layout.place.get(from), b = layout.place.get(to);
    if (!a || !b) return "";
    const sx = a.col * colPitch + cardW, sy = a.lane * rowPitch + cardH / 2;
    const ex = b.col * colPitch,         ey = b.lane * rowPitch + cardH / 2;
    const dx = Math.max(24, (ex - sx) * 0.5);
    const fired = b.idx < state.currentIndex;
    return `<path d="M${sx},${sy} C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}" fill="none" stroke="${fired ? "#78716c" : "#e7e5e4"}" stroke-width="2" marker-end="url(#flow-arrow)"/>`;
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

  const prov = state.meta.provenance;
  const legend = prov ? `
      <div class="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
        <span class="font-semibold text-stone-600">${prov.steps.real} of ${prov.steps.total} steps from a real source</span>
        <span class="flex items-center gap-1">${provChip("live")} live</span>
        <span class="flex items-center gap-1">${provChip("recorded")} recorded</span>
        <span class="flex items-center gap-1">${provChip("simulated")} simulated</span>
      </div>` : "";
  return `
    <section class="border-b border-stone-200 bg-stone-50">
      ${legend}
      <div id="timeline-scroll" class="px-6 py-3 overflow-x-auto">
        <div style="width:${W}px;">
          <div class="relative" style="width:${W}px; height:${H}px;">
            ${svg}
            ${cards}
          </div>
          <div class="h-1 bg-stone-200 rounded overflow-hidden mt-3" style="width:${W}px;">
            <div class="h-1 bg-amber-400 transition-all duration-300" style="width:${pct}%"></div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function lastEventCaption() {
  if (!state.log || state.log.length === 0) return `
    <div class="px-6 py-3 bg-white border-b border-stone-200 text-sm text-stone-500">
      Press <b>Step forward</b> to advance this demand through the workflow.
    </div>
  `;
  const last = state.log[0];
  return `
    <div class="px-6 py-3 bg-white border-b border-stone-200">
      <div class="flex items-start gap-4">
        <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold pt-0.5">Last event</div>
        <div class="flex-1">
          <div class="font-medium text-stone-900 flex items-center gap-2">${last.eventName} ${provChip(last.provenance)}</div>
          <div class="text-sm text-stone-600 mt-0.5">
            <span class="mono text-stone-500">${last.boundedContext}</span> · ${last.role} ·
            <span class="text-stone-500">${new Date(last.occurredAt).toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  `;
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
  const p = state.prevInstance;
  if (!p || id == null) return undefined;
  if (agg === p.rootAggregate && p.root && p.root.id === id) return p.root;
  return (p.entities?.[agg] || []).find((r) => r.id === id);
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
  const inst = state.instance || {};
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
        <div class="text-sm text-stone-500 mr-2 tabular-nums">step <span class="font-semibold text-stone-800">${state.currentIndex}</span> / ${total}</div>
        <button id="btn-reset" ${state.busy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Reset</button>
        <button id="btn-next" ${state.busy || state.currentIndex >= total ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">Step forward →</button>
        <button id="btn-all" ${state.busy || state.currentIndex >= total ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Run all</button>
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    ${timeline()}
    ${lastEventCaption()}
    <main class="flex-1 overflow-auto p-6 flex flex-col gap-4">
      ${rootCard}
      ${otherCards ? `<div class="grid gap-4 items-start" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${otherCards}</div>` : ""}
    </main>`;
}


function bindDetail() {
  document.getElementById("btn-back")?.addEventListener("click", () => navigate("#"));
  document.getElementById("btn-next")?.addEventListener("click", doNext);
  document.getElementById("btn-all")?.addEventListener("click", doRunAll);
  document.getElementById("btn-reset")?.addEventListener("click", doReset);
}

// ---------------------------------------------------------------------------
// Render dispatcher
// ---------------------------------------------------------------------------

function render() {
  const prevScroll = document.getElementById("timeline-scroll")?.scrollLeft ?? 0;
  const mainShiftCls = state.chatOpen ? "mr-[420px]" : "";
  // Every main view is wrapped with the tenant bar (org switcher + breadcrumb +
  // user) so the whole app reads as a multi-tenant console.
  const wrap = (inner) => `<div class="${mainShiftCls} flex flex-col min-h-screen transition-[margin-right] duration-200">${tenantBar()}${registryBanner()}${inner}</div>${chatPanel()}${modelToast()}${workflowModelDialog()}${modelInspectDialog()}${newOrgDialog()}${newWfDialog()}`;

  if (state.view === "login") {
    root.innerHTML = loginView();
    bindLogin();
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
    const activeIdx = state.currentIndex - 1;
    if (activeIdx >= 0 && scroller) {
      const node = scroller.querySelector(`[data-step="${activeIdx}"]`);
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
  } else if (state.view === "no-model") {
    root.innerHTML = wrap(noModelView());
    bindTenantBar();
    bindNoModel();
    bindWorkflowModel();
    bindChat();
  } else if (state.view === "bcs") {
    root.innerHTML = wrap(explorerView());
    bindTenantBar();
    bindExplorer();
    bindChat();  } else if (state.view === "bc") {
    root.innerHTML = wrap(bcWorkbenchView());
    bindTenantBar();
    bindBcWorkbench();
    bindChat();  } else if (state.view === "org") {
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
  const curId = state.me?.workflowId || "";
  const check = `<svg viewBox="0 0 20 20" fill="none" class="h-4 w-4 text-stone-900 shrink-0"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
        <div class="max-h-72 overflow-auto">${list}</div>
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

function tenantBar() {
  const me = state.me;
  const subject = me?.subject || "system";
  const isAdmin = !!me?.isPlatformAdmin;
  const orgs = state.orgs || [];
  const curId = me?.organizationId || "";
  const curOrg = orgs.find((o) => o.id === curId) || { id: curId, name: currentOrgName() };
  const workflows = me?.workflows || [];
  const curProj = me?.workflowId || "";
  const emptyOrg = workflows.length === 0;
  const projName = (workflows.find((p) => p.id === curProj) || {}).name || (emptyOrg ? "No workflow" : "Default");
  const projControl = emptyOrg
    ? `<button id="wf-empty-create" class="text-sm text-amber-300 hover:text-amber-200" title="This organization has no workflows yet">+ Create workflow</button>`
    : `<div class="relative" id="wf-menu-wrap">
          <button id="wf-menu-btn" aria-haspopup="menu" aria-expanded="${state.wfMenuOpen ? "true" : "false"}" class="flex items-center gap-2 rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800 pl-1.5 pr-1.5 py-0.5" title="Workflow menu — switch or create">
            ${workflowGlyph("h-4 w-4 text-stone-400")}
            <span class="text-sm font-medium text-stone-100 max-w-[220px] truncate">${escapeHtml(projName)}</span>
            <svg viewBox="0 0 20 20" fill="none" class="h-3.5 w-3.5 text-stone-400 shrink-0"><path d="M7 8l3-3 3 3M7 12l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          ${state.wfMenuOpen ? workflowMenuPanel() : ""}
        </div>`;
  return `
    <div class="bg-stone-900 text-stone-300 text-sm border-b border-stone-800">
      <div class="px-6 py-1.5 flex items-center gap-3">
        <span class="flex items-center gap-1.5 text-stone-100">${qlerifyMark("h-4 w-4")}<span class="font-semibold tracking-tight">Qlerify<span class="text-amber-400">·</span>Live</span></span>
        <span class="text-stone-500">›</span>
        <div class="relative" id="org-menu-wrap">
          <button id="org-menu-btn" aria-haspopup="menu" aria-expanded="${state.orgMenuOpen ? "true" : "false"}" class="flex items-center gap-2 rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800 pl-1 pr-1.5 py-0.5" title="Organisation menu — switch, create, or manage">
            ${orgAvatar(curOrg, "h-6 w-6", "text-[11px]")}
            <span class="text-sm font-medium text-stone-100 max-w-[220px] truncate">${escapeHtml(currentOrgName())}</span>
            <svg viewBox="0 0 20 20" fill="none" class="h-3.5 w-3.5 text-stone-400 shrink-0"><path d="M7 8l3-3 3 3M7 12l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          ${state.orgMenuOpen ? orgMenuPanel() : ""}
        </div>
        <span class="text-stone-500">›</span>
        ${projControl}
        <div class="flex-1"></div>
        <a href="#org" class="px-2 py-0.5 rounded hover:bg-stone-800 ${state.view === "org" ? "bg-stone-800 text-white" : ""}" title="Organisation portfolio — every workflow at a glance">▣ Portfolio</a>
        <a href="#" class="px-2 py-0.5 rounded hover:bg-stone-800 ${(state.view === "dashboard" || state.view === "detail") ? "bg-stone-800 text-white" : ""}" title="Workflow simulator — the model dashboard">▦ Workflow</a>
        <a href="#bcs" class="px-2 py-0.5 rounded hover:bg-stone-800 ${(state.view === "bcs" || state.view === "bc") ? "bg-stone-800 text-white" : ""}" title="Systems — data explorer">🔌 Systems</a>
        <span class="text-stone-500">·</span>
        <div class="relative" id="acct-menu-wrap">
          <button id="acct-menu-btn" aria-haspopup="menu" aria-expanded="${state.acctMenuOpen ? "true" : "false"}" class="flex items-center gap-2 rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800 pl-1 pr-1.5 py-0.5" title="Account — signed in as ${escapeHtml(subject)}">
            ${isAdmin ? `<span class="text-[10px] uppercase font-bold tracking-wide px-1.5 py-px rounded bg-amber-500 text-stone-900" title="You are signed in as a platform superuser — you can act across every organization, and every cross-tenant action is audited">Superuser</span>` : ""}
            ${userAvatar(subject, isAdmin)}
            <svg viewBox="0 0 20 20" fill="none" class="h-3.5 w-3.5 text-stone-400 shrink-0"><path d="M7 8l3-3 3 3M7 12l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          ${state.acctMenuOpen ? accountMenuPanel() : ""}
        </div>
      </div>
    </div>`;
}

function bindTenantBar() {
  // --- Account menu (avatar dropdown: identity + sign out) ------------------
  // Dismiss without acting (Escape / outside-click): close and return focus to
  // the trigger so a keyboard user isn't dropped onto <body> by the re-render.
  const dismissAcctMenu = () => { state.acctMenuOpen = false; render(); document.getElementById("acct-menu-btn")?.focus(); };
  document.getElementById("acct-menu-btn")?.addEventListener("click", () => { state.acctMenuOpen = !state.acctMenuOpen; render(); });
  document.getElementById("acct-menu-backdrop")?.addEventListener("click", dismissAcctMenu);
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
    }
  };
  // --- Workflow menu (switcher dropdown: switch / create) -------------------
  const dismissWfMenu = () => { state.wfMenuOpen = false; render(); document.getElementById("wf-menu-btn")?.focus(); };
  document.getElementById("wf-menu-btn")?.addEventListener("click", () => { state.wfMenuOpen = !state.wfMenuOpen; render(); });
  document.getElementById("wf-menu-backdrop")?.addEventListener("click", dismissWfMenu);
  document.querySelectorAll("[data-wf-pick]").forEach((el) => el.addEventListener("click", async () => {
    const id = el.getAttribute("data-wf-pick");
    state.wfMenuOpen = false;
    if (id === (state.me?.workflowId || "")) { render(); return; } // already the current workflow — just close
    AUTH.setWorkflow(id);
    await ensureMe();
    onHashChange(); // reloads the current view for the newly selected workflow
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

  // --- Organisation menu (avatar dropdown: switch / admin / create) ---------
  // Dismiss without acting (Escape / outside-click): close and return focus to
  // the trigger so a keyboard user isn't dropped onto <body> by the re-render.
  const dismissOrgMenu = () => { state.orgMenuOpen = false; render(); document.getElementById("org-menu-btn")?.focus(); };
  document.getElementById("org-menu-btn")?.addEventListener("click", () => {
    state.orgMenuOpen = !state.orgMenuOpen;
    if (state.orgMenuOpen) loadOrgMemberCount(); // best-effort subtitle, re-renders when ready
    render();
  });
  document.getElementById("org-menu-backdrop")?.addEventListener("click", dismissOrgMenu);
  document.getElementById("org-menu-admin")?.addEventListener("click", () => { state.orgMenuOpen = false; navigate("#admin"); });
  document.querySelectorAll("[data-org-pick]").forEach((el) => el.addEventListener("click", () => {
    const id = el.getAttribute("data-org-pick");
    state.orgMenuOpen = false;
    if (id === (state.me?.organizationId || "")) { render(); return; } // already the current org — just close
    AUTH.setOrg(id); // also clears the selected workflow
    state.orgMemberCount = null; state.orgMemberCountFor = null; // invalidate the cached subtitle for the new org
    onHashChange(); // reloads whoami + the current view for the newly selected org
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
// button. Mirrors workflowModelDialog()'s open/busy/err state pattern.
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

// A workflow exists but has no model yet (freshly created — nothing is preloaded).
// Prompt the user to point it at their own Qlerify model (opens the same dialog
// the dashboard's "⚙ Set model" button uses).
function noModelView() {
  return `
    <main class="flex-1 flex items-center justify-center p-8">
      <div class="w-full max-w-md rounded-xl border border-stone-200 bg-white p-6 shadow-sm text-center">
        <div class="text-3xl mb-2">🧩</div>
        <div class="text-lg font-semibold text-stone-900">This workflow has no model yet</div>
        <div class="text-sm text-stone-500 mt-1 mb-5">Point it at a Qlerify model to generate its workflow and data. Nothing is preloaded — the model is yours.</div>
        <button id="nomodel-set" class="rounded-md bg-stone-900 text-white py-2 px-4 text-sm font-medium hover:bg-stone-800">⚙ Set this workflow's model</button>
      </div>
    </main>`;
}

function bindNoModel() {
  document.getElementById("nomodel-set")?.addEventListener("click", () => { state.projModelOpen = true; state.projModelErr = null; render(); });
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

// --- Org Admin page --------------------------------------------------------

async function loadAdmin() {
  const tab = state.admin?.tab || "general";
  const [members, roles, markings, environments, workspaces, workflows, audit] = await Promise.all([
    api("/v1/members").catch(() => []),
    api("/v1/role-assignments").catch(() => []),
    api("/v1/markings").catch(() => []),
    api("/v1/environments").catch(() => []),
    api("/v1/workspaces").catch(() => []),
    api("/v1/workflows").catch(() => []),
    api("/v1/audit?limit=60").catch(() => []),
  ]);
  state.admin = { tab, members, roles, markings, environments, workspaces, workflows, audit };
  render();
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
    </tr>`).join("");
    return `
      <div class="mb-4 flex items-end gap-2">
        <div><label class="block text-xs text-stone-500 mb-1">Username (IdP subject)</label><input id="m-subject" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="jane@corp" /></div>
        <div><label class="block text-xs text-stone-500 mb-1">Email</label><input id="m-email" class="rounded-md border border-stone-300 px-3 py-1.5 text-sm" placeholder="optional" /></div>
        <button id="m-add" class="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">Add member</button>
      </div>
      ${tbl(["Username", "Email", "Roles", "Status"], rows, "No members.")}`;
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
    const sysProjId = state.me?.systemWorkflowId;
    // The system/demo workflow is infrastructure, not a manageable tenant workflow
    // (it can't be deleted and is re-seeded every boot). Keep it OUT of this
    // management table — it still appears in the breadcrumb for navigation.
    const manageable = (a.workflows || []).filter((pr) => pr.id !== sysProjId);
    const hidSystem = (a.workflows || []).length !== manageable.length;
    const rows = manageable.map((pr) => `<tr>
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
    state.admin = { ...(state.admin || {}), tab: el.dataset.adminTab };
    render();
  }));
  const reload = () => loadAdmin();
  const act = async (fn) => { try { await fn(); await reload(); } catch (e) { alert(e.message); } };

  document.getElementById("m-add")?.addEventListener("click", () => act(async () => {
    const subject = document.getElementById("m-subject").value.trim();
    if (!subject) throw new Error("Username is required");
    await api("/v1/memberships", { method: "POST", body: JSON.stringify({ subject, email: document.getElementById("m-email").value.trim() || undefined }) });
  }));
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
