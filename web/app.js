// Ericsson HW Flow demo UI — vanilla JS + Tailwind.
// Two views:
//   1. Dashboard:  table of demands with status + progress, "+ New demand" button.
//   2. Detail:     per-demand timeline + 7 BC panels, step-forward controls.
// Navigation is hash-based: "#" → dashboard, "#demand/<id>" → detail.

const API = "";
const role = "Automation";
const root = document.getElementById("app");

const BC_PANELS = [
  { bc: "Helix",     title: "Helix",     subtitle: "Demand & build planning", tables: ["demands","buildPlans","builds","buildDemand"] },
  { bc: "PRIM",      title: "PRIM",      subtitle: "Product & release master", tables: ["projects","bomItems","engineeringReleases"] },
  { bc: "SAP",       title: "SAP",       subtitle: "ERP, procurement & orders", tables: ["purchaseOrders","workOrders"] },
  { bc: "ESTER",     title: "ESTER",     subtitle: "Engineering changes", tables: ["engineeringChanges"] },
  { bc: "Compass",   title: "Compass",   subtitle: "Production scheduling", tables: ["sites","lines","bookings"] },
  { bc: "Test",      title: "Test",      subtitle: "NPI test results", tables: ["testResults"] },
  { bc: "Logistics", title: "Logistics", subtitle: "Warehouse, pack & ship", tables: ["units","shipments"] },
];

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

const state = {
  // global
  view: "dashboard",     // "dashboard" | "detail"
  demands: [],
  events: [],
  busy: false,
  // detail view
  demandId: null,
  log: [],
  snapshot: null,
  prev: null,
  currentIndex: 0,
  withDisruptions: true,
  // chat
  chatOpen: false,
  chatMessages: [],      // Anthropic.MessageParam[]
  chatInput: "",
  chatBusy: false,
  chatInfo: null,        // { model, effort, apiKeyConfigured, ... }
  chatError: null,
  // registry health — non-null message means the loaded model doesn't match
  // the simulator's event registry; surfaced as a top banner.
  registryError: null,
  // model sync / version history
  model: null,           // ModelStatus from /api/model/status
  modelBusy: false,
  modelMsg: null,        // last fetch/roll message to flash in the UI
  modelFileOpen: false,  // model viewer dialog visibility
  modelFile: null,       // { path, content } of workflow.json
  modelSource: null,     // { url, defaultUrl, effective } source config
  modelSourceInput: "",  // editable source URL field value
  modelSourceBusy: false,
  modelSourceEditing: false, // click-to-edit toggle for the source URL
};

async function api(path, opts = {}) {
  const headers = { "x-role": role, ...(opts.headers || {}) };
  if (opts.body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(API + path, { ...opts, headers });
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
    const desc = cur ? `${cur.qty} × ${cur.productName} for ${cur.customerId} (${cur.status})` : "(unknown)";
    content = [
      { type: "text", text: `[Context: viewing demand ${state.demandId} — ${desc}. When the user says "this demand", "it", or refers to a step without naming a demand, they mean this one.]` },
      { type: "text", text },
    ];
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
      const writeTone = (b.name === "next_step" || b.name === "create_demand") ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-stone-50";
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

  const examples = state.view === "detail" ? [
    "Explain the next step in this workflow!",
    "Explain the last thing that was completed on this workflow.",
    "Why hasn't this demand moved forward yet?",
    "Move this demand forward one step.",
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
          <div class="text-sm text-stone-800 font-medium">Process advisor</div>
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
            Ask about demands, the workflow, or have me advance a step. I'll always confirm before changing anything.
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

async function loadModelStatus() {
  try {
    state.model = await api("/api/model/status");
  } catch (e) {
    state.model = null;
  }
}

// Refresh everything that is rendered from the Qlerify model after it changes.
async function reloadFromModel() {
  await loadModelStatus();
  // Fetch/roll now happen inside the inspect dialog — keep the shown JSON current.
  if (state.modelFileOpen) {
    try { state.modelFile = await api("/api/model/file"); } catch { /* keep previous content */ }
  }
  if (state.view === "detail") await loadDetail();
  else await loadDashboard();
}

async function fetchModel() {
  if (state.modelBusy) return;
  state.modelBusy = true; state.modelMsg = null; render();
  try {
    const res = await api("/api/model/fetch", { method: "POST", body: "{}" });
    state.modelMsg = { ok: true, text: res.message };
    await reloadFromModel();
  } catch (e) {
    state.modelMsg = { ok: false, text: e.message };
  } finally {
    state.modelBusy = false; render();
    flashModelMsg();
  }
}

async function rollModel(direction) {
  if (state.modelBusy) return;
  state.modelBusy = true; state.modelMsg = null; render();
  try {
    const res = await api("/api/model/roll", { method: "POST", body: JSON.stringify({ direction }) });
    state.modelMsg = { ok: true, text: res.message };
    await reloadFromModel();
  } catch (e) {
    state.modelMsg = { ok: false, text: e.message };
  } finally {
    state.modelBusy = false; render();
    flashModelMsg();
  }
}

// Jump straight to a stored version from the version sidebar.
async function restoreModelVersion(index) {
  if (state.modelBusy) return;
  state.modelBusy = true; state.modelMsg = null; render();
  try {
    const res = await api("/api/model/restore", { method: "POST", body: JSON.stringify({ index }) });
    state.modelMsg = { ok: true, text: res.message };
    await reloadFromModel();
  } catch (e) {
    state.modelMsg = { ok: false, text: e.message };
  } finally {
    state.modelBusy = false; render();
    flashModelMsg();
  }
}

async function openModelFile() {
  state.modelFileOpen = true;
  state.modelFile = null;
  state.modelSourceEditing = false;
  render();
  // Refresh the version list too, so the sidebar reflects the latest history.
  const [file, source, status] = await Promise.allSettled([api("/api/model/file"), api("/api/model/source"), api("/api/model/status")]);
  state.modelFile = file.status === "fulfilled" ? file.value : { path: "", content: "", error: file.reason?.message };
  state.modelSource = source.status === "fulfilled" ? source.value : null;
  state.modelSourceInput = state.modelSource ? (state.modelSource.workflowUrl || "") : "";
  if (status.status === "fulfilled") state.model = status.value;
  render();
}

function closeModelFile() {
  state.modelFileOpen = false;
  render();
}

async function saveModelSource() {
  if (state.modelSourceBusy || state.modelBusy) return;
  const url = state.modelSourceInput.trim();
  // A value equal to the default link means "use default" → clear the override.
  const payloadUrl = url && url !== (state.modelSource?.defaultWorkflowUrl ?? "") ? url : null;
  state.modelSourceBusy = true; render();
  try {
    state.modelSource = await api("/api/model/source", { method: "PUT", body: JSON.stringify({ url: payloadUrl }) });
    state.modelSourceInput = state.modelSource.workflowUrl || "";
    state.modelSourceEditing = false;
  } catch (e) {
    state.modelMsg = { ok: false, text: e.message };
    state.modelSourceBusy = false; render(); flashModelMsg();
    return;
  }
  state.modelSourceBusy = false;
  // Pull the model from the new source so it lands as a fresh version with its
  // source URL recorded — that per-version record replaces the old "override" badge.
  await fetchModel();
}

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
  if (isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Sidebar listing every stored version (newest first), each with a Restore
// action; the materialized version is highlighted instead.
function modelVersionSidebar() {
  const m = state.model;
  const versions = (m && m.versions) || [];
  if (versions.length === 0) {
    return `<aside class="w-56 shrink-0 border-r border-stone-200 bg-white overflow-auto p-3 text-[11px] text-stone-400 leading-relaxed">No saved versions yet. Fetch the model to start the history.</aside>`;
  }
  // For versions whose source wasn't recorded, fall back to the project's
  // workflow (name + link) so the row is still actionable rather than a dead end.
  const fallbackUrl = (state.modelSource && (state.modelSource.defaultWorkflowUrl || state.modelSource.workflowUrl)) || "";
  const fallbackName = (m && m.workflowName) || "Open workflow";
  const rows = versions
    .map((v, i) => {
      const isCurrent = i === m.current;
      const sourceCls = v.source === "initial" ? "bg-stone-100 text-stone-500" : "bg-sky-100 text-sky-700";
      const events = v.summary ? v.summary.events : 0;
      let srcLine;
      if (v.sourceUrl) {
        // Prefer the workflow's name; fall back to the shortened URL if unnamed.
        const label = v.sourceName || shortWorkflowUrl(v.sourceUrl);
        const monoCls = v.sourceName ? "" : "mono ";
        const tip = v.sourceName ? `${v.sourceName} — ${v.sourceUrl}` : v.sourceUrl;
        srcLine = `<a href="${escapeHtml(v.sourceUrl)}" target="_blank" rel="noopener" class="block text-[10px] ${monoCls}text-sky-700 hover:text-sky-900 truncate mt-0.5" title="Fetched from ${escapeHtml(tip)}">${escapeHtml(label)} ↗</a>`;
      } else if (fallbackUrl) {
        srcLine = `<a href="${escapeHtml(fallbackUrl)}" target="_blank" rel="noopener" class="block text-[10px] text-sky-700 hover:text-sky-900 truncate mt-0.5" title="Source not recorded — opens ${escapeHtml(fallbackName)}">${escapeHtml(fallbackName)} ↗</a>`;
      } else {
        srcLine = `<div class="text-[10px] text-stone-300 italic mt-0.5">source unknown</div>`;
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
            : `<button data-restore="${i}" ${state.modelBusy ? "disabled" : ""} class="model-restore-btn text-[10px] px-2 py-1 rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 shrink-0 mt-0.5" title="Restore this version">Restore</button>`}
        </li>
      `;
    })
    .reverse()
    .join("");
  return `
    <aside class="w-56 shrink-0 border-r border-stone-200 bg-white overflow-auto">
      <div class="px-3 pt-3 pb-1 text-[10px] uppercase tracking-widest text-stone-500 font-semibold sticky top-0 bg-white">Versions</div>
      <ul class="px-2 pb-3 flex flex-col gap-1">${rows}</ul>
    </aside>
  `;
}

// Inspect-model dialog: fetch / roll versions / browse the raw workflow.json and
// the configured source URL, all in one place.
function modelFileDialog() {
  if (!state.modelFileOpen) return "";
  const f = state.modelFile;
  const m = state.model;
  const body = !f
    ? `<div class="text-stone-500 text-sm p-6">Loading model…</div>`
    : f.error
      ? `<div class="text-rose-700 text-sm p-6">⚠ ${escapeHtml(f.error)}</div>`
      : `<pre class="mono text-[12px] leading-relaxed whitespace-pre p-4 overflow-auto">${escapeHtml(f.content)}</pre>`;
  const sizeKb = f && f.content ? Math.round(f.content.length / 1024) : 0;
  const src = state.modelSource;
  const effective = src ? src.workflowUrl : "";
  const versionLabel = m && m.total > 0
    ? `v${m.current + 1}/${m.total}${m.currentVersion ? ` · ${m.currentVersion.summary.events} events` : ""}`
    : "not yet versioned";
  const disBack = state.modelBusy || !m || !m.canBack;
  const disFwd  = state.modelBusy || !m || !m.canForward;
  return `
    <div id="model-file-backdrop" class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
      <div class="bg-white rounded-lg shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col" role="dialog" aria-modal="true">
        <div class="px-5 py-3 border-b border-stone-200 flex flex-col gap-2.5">
          <div class="flex items-center gap-3">
            <div class="flex-1 min-w-0">
              <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Qlerify model</div>
              <div class="text-[12px] text-stone-600 tabular-nums truncate">${escapeHtml(versionLabel)}${m && m.workflowName ? ` · ${escapeHtml(m.workflowName)}` : ""}</div>
            </div>
            ${f && f.content ? `<span class="text-[11px] text-stone-400 tabular-nums shrink-0">${sizeKb} KB</span>` : ""}
            <button id="model-file-close" class="text-stone-400 hover:text-stone-700 text-lg leading-none shrink-0" title="Close">×</button>
          </div>
          <div class="flex items-center gap-1.5">
            <button id="btn-model-back" ${disBack ? "disabled" : ""} class="px-2 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40" title="Roll back to previous model version">↩</button>
            <button id="btn-model-fetch" ${state.modelBusy ? "disabled" : ""} class="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50 font-medium" title="Fetch the latest model from the Qlerify modeller">${state.modelBusy ? "⏳ Syncing…" : "⤓ Fetch model"}</button>
            <button id="btn-model-fwd" ${disFwd ? "disabled" : ""} class="px-2 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40" title="Roll forward to next model version">↪</button>
            <span class="text-[11px] uppercase tracking-wide text-stone-500 font-semibold shrink-0 ml-auto">Source</span>
            ${effective
              ? `<a href="${escapeHtml(effective)}" target="_blank" rel="noopener" class="min-w-0 max-w-xs text-[12px] mono text-sky-700 hover:text-sky-900 underline decoration-dotted truncate" title="${escapeHtml(effective)}">${escapeHtml(shortWorkflowUrl(effective))} ↗</a>`
              : `<span class="text-[12px] text-stone-400 italic">no source configured</span>`}
            <button id="model-source-edit" class="px-2.5 py-1 text-xs rounded-md border border-stone-300 bg-white hover:bg-stone-50 font-medium shrink-0" title="Edit the source workflow URL — saving pulls it in as a new version">✎ Edit</button>
          </div>
        </div>
        <div class="flex-1 flex min-h-0">
          ${modelVersionSidebar()}
          <div id="model-file-scroll" class="flex-1 overflow-auto bg-stone-50">${body}</div>
        </div>
      </div>
    </div>
    ${modelSourceEditDialog()}
  `;
}

// Secondary modal, layered on top of the inspect dialog, for editing the source URL.
function modelSourceEditDialog() {
  if (!state.modelSourceEditing) return "";
  const src = state.modelSource;
  const placeholder = src ? (src.defaultWorkflowUrl || "https://app.qlerify.com/workflow/<project>/<workflow>") : "https://app.qlerify.com/workflow/<project>/<workflow>";
  return `
    <div id="model-source-backdrop" class="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-6">
      <div class="bg-white rounded-lg shadow-2xl w-full max-w-lg flex flex-col" role="dialog" aria-modal="true">
        <div class="px-5 py-3 border-b border-stone-200 flex items-center gap-3">
          <div class="flex-1 text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Edit model source URL</div>
          <button id="model-source-cancel-x" class="text-stone-400 hover:text-stone-700 text-lg leading-none" title="Cancel">×</button>
        </div>
        <div class="px-5 py-4 flex flex-col gap-3">
          <input id="model-source-input" type="text" value="${escapeHtml(state.modelSourceInput)}" placeholder="${escapeHtml(placeholder)}" class="w-full text-[12px] mono border border-stone-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400 focus:border-amber-400" />
          <div class="text-[11px] text-stone-400 leading-relaxed">Paste a Qlerify workflow URL. Leave blank — or matching the default — to reset to the workflow in codegen.json.</div>
          <div class="flex items-center justify-end gap-2">
            <button id="model-source-cancel" ${state.modelSourceBusy ? "disabled" : ""} class="px-3 py-1.5 text-xs rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Cancel</button>
            <button id="model-source-save" ${state.modelSourceBusy ? "disabled" : ""} class="px-3 py-1.5 text-xs rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">${state.modelSourceBusy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

let modelMsgTimer = null;
function flashModelMsg() {
  if (modelMsgTimer) clearTimeout(modelMsgTimer);
  modelMsgTimer = setTimeout(() => { state.modelMsg = null; render(); }, 6000);
}

// Single dashboard-header entry point. Fetch / version rolling / source editing
// all now live inside the Inspect model dialog (see modelFileDialog).
function modelControls() {
  const m = state.model;
  const label = m && m.total > 0
    ? `model v${m.current + 1}/${m.total}${m.currentVersion ? ` · ${m.currentVersion.summary.events} events` : ""}`
    : "model — not yet versioned";
  return `
    <div class="flex items-center gap-1.5 mr-1" title="Qlerify model${m && m.workflowName ? " · " + escapeHtml(m.workflowName) : ""}">
      <button id="btn-model-view" class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 font-medium" title="Inspect the Qlerify model — fetch, roll versions, view workflow.json">👁 Inspect model</button>
      <button id="lbl-model-view" class="text-[10px] text-stone-500 hover:text-stone-800 underline decoration-dotted tabular-nums ml-0.5 hidden lg:inline" title="Inspect the Qlerify model">${escapeHtml(label)}</button>
    </div>
  `;
}

// Persistent banner shown when the loaded Qlerify model doesn't match the
// simulator's event registry (EVENTS is empty server-side). Rendered in flow at
// the very top so it pushes the view down rather than crashing the app.
function registryBanner() {
  if (!state.registryError) return "";
  return `
    <div class="bg-rose-600 text-white px-6 py-3 text-sm shadow">
      <div class="font-semibold">⚠ Loaded Qlerify model doesn't match the simulator</div>
      <div class="mt-0.5 opacity-90">${escapeHtml(state.registryError)}</div>
      <div class="mt-1 text-xs opacity-80">The simulator's 28-step event registry couldn't be built from the current <span class="mono">.qlerify/workflow.json</span>. Restore a matching model version, then it will hot-reload and this banner clears.</div>
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

function bindModelControls() {
  document.getElementById("btn-model-fetch")?.addEventListener("click", fetchModel);
  document.getElementById("btn-model-back")?.addEventListener("click", () => rollModel("back"));
  document.getElementById("btn-model-fwd")?.addEventListener("click", () => rollModel("forward"));
  document.getElementById("btn-model-view")?.addEventListener("click", openModelFile);
  document.querySelectorAll(".model-restore-btn").forEach((btn) => {
    btn.addEventListener("click", () => restoreModelVersion(Number(btn.getAttribute("data-restore"))));
  });
  document.getElementById("lbl-model-view")?.addEventListener("click", openModelFile);
  document.getElementById("model-file-close")?.addEventListener("click", closeModelFile);
  document.getElementById("model-file-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "model-file-backdrop") closeModelFile();
  });
  const openEdit = () => {
    state.modelSourceEditing = true;
    state.modelSourceInput = state.modelSource?.workflowUrl || "";
    render();
    const el = document.getElementById("model-source-input");
    if (el) { el.focus(); el.select(); }
  };
  const closeEdit = () => {
    state.modelSourceEditing = false;
    state.modelSourceInput = state.modelSource?.workflowUrl || "";
    render();
  };
  document.getElementById("model-source-edit")?.addEventListener("click", openEdit);
  document.getElementById("model-source-cancel")?.addEventListener("click", closeEdit);
  document.getElementById("model-source-cancel-x")?.addEventListener("click", closeEdit);
  document.getElementById("model-source-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "model-source-backdrop") closeEdit();
  });
  const srcInput = document.getElementById("model-source-input");
  if (srcInput) {
    srcInput.addEventListener("input", (e) => { state.modelSourceInput = e.target.value; });
    srcInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveModelSource(); }
      else if (e.key === "Escape") { closeEdit(); }
    });
  }
  document.getElementById("model-source-save")?.addEventListener("click", saveModelSource);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function parseHash() {
  const m = (location.hash || "").match(/^#demand\/([\w-]+)/);
  return m ? { view: "detail", demandId: m[1] } : { view: "dashboard" };
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
  state.prev = null;
  state.snapshot = null;

  if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }

  if (r.view === "detail") {
    await loadDetail();
  } else {
    await loadDashboard();
    // Poll every 5s so "last activity" pills age in front of the audience.
    dashboardTimer = setInterval(() => {
      if (state.view === "dashboard" && !state.busy && !state.modelFileOpen) loadDashboard().catch(() => {});
    }, 5000);
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function loadDashboard() {
  const [demands, events] = await Promise.all([api("/sim/demands"), api("/sim/events"), loadRegistryStatus()]);
  state.demands = demands;
  state.events = events;
  if (!state.model) await loadModelStatus();
  render();
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
  if (!confirm("Reset this demand and remove all its data?")) return;
  state.busy = true; render();
  try {
    await api("/sim/reset", { method: "POST", body: JSON.stringify({ demandId }) });
    await loadDashboard();
  } finally {
    state.busy = false; render();
  }
}

// Format a relative time like "3s ago" or "2 min ago" or "1 h ago".
function relativeTime(secs) {
  if (secs == null) return "—";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

// Traffic-light tone keyed on real wall-clock dwell. Demo-friendly thresholds:
// active <30s, slow <2min, stalled >=2min. Final + done → grey (complete).
function staleness(dwellSeconds, isComplete) {
  if (isComplete) return { dot: "bg-stone-300", label: "complete", textCls: "text-stone-500" };
  if (dwellSeconds == null)   return { dot: "bg-stone-300", label: "new",      textCls: "text-stone-500" };
  if (dwellSeconds < 30)      return { dot: "bg-emerald-500 animate-pulse", label: "active",  textCls: "text-emerald-700" };
  if (dwellSeconds < 120)     return { dot: "bg-amber-500",  label: "slow",   textCls: "text-amber-700"  };
  return                            { dot: "bg-rose-500",   label: "stalled", textCls: "text-rose-700"  };
}

function dashboardRow(d) {
  const pct = Math.round((d.progress / d.total) * 100);
  const lastBC = d.lastEvent?.boundedContext ?? "";
  const isComplete = d.status === "DELIVERED";
  const tone = staleness(d.dwellSeconds, isComplete);
  return `
    <tr class="cursor-pointer hover:bg-amber-50 transition-colors" data-go="#demand/${d.id}">
      <td class="px-4 py-3">
        <span class="inline-block w-2 h-2 rounded-full ${tone.dot}" title="${tone.label}"></span>
      </td>
      <td class="px-4 py-3 mono text-stone-500 text-xs">${d.id.slice(0,16)}…</td>
      <td class="px-4 py-3 text-sm text-stone-700">${d.customerId}</td>
      <td class="px-4 py-3 text-sm font-medium text-stone-900">${d.productName}</td>
      <td class="px-4 py-3 text-sm tabular-nums text-stone-700">${d.qty}</td>
      <td class="px-4 py-3 text-sm text-stone-700">${d.requestedWeek}</td>
      <td class="px-4 py-3">${pill(d.status, d.status)}</td>
      <td class="px-4 py-3 w-64">
        <div class="flex items-center gap-2">
          <div class="flex-1 h-1.5 bg-stone-200 rounded overflow-hidden">
            <div class="h-1.5 bg-amber-400 transition-all" style="width:${pct}%"></div>
          </div>
          <div class="text-xs text-stone-500 tabular-nums w-12 text-right">${d.progress}/${d.total}</div>
        </div>
      </td>
      <td class="px-4 py-3 text-xs">
        ${d.lastEvent ? `
          <div class="text-stone-700">${d.lastEvent.eventName}</div>
          <div class="text-stone-500 text-[11px]">${lastBC} · <span class="${tone.textCls} font-medium">${relativeTime(d.dwellSeconds)}</span></div>
        ` : `<span class="text-stone-400">no events yet</span>`}
      </td>
      <td class="px-4 py-3 text-right">
        <button class="text-stone-400 hover:text-rose-600 text-sm" data-delete="${d.id}" title="Reset this demand">✕</button>
      </td>
    </tr>
  `;
}

function dashboardView() {
  const rows = state.demands.map(dashboardRow).join("");
  const empty = state.demands.length === 0;
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Ericsson HW Flow — Demands</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">All demands in flight</div>
        </div>
        ${modelControls()}
        <button id="btn-new-demand" ${state.busy ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">+ New demand</button>
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    <main class="flex-1 overflow-auto p-6">
      ${empty ? `
        <div class="max-w-md mx-auto mt-16 text-center">
          <div class="text-stone-400 text-5xl mb-3">∅</div>
          <div class="text-lg font-medium text-stone-700">No demands yet</div>
          <div class="text-sm text-stone-500 mt-1">Click <b>+ New demand</b> to start a fresh customer order through the workflow.</div>
        </div>
      ` : `
        <div class="rounded-lg border border-stone-200 bg-white overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-stone-50 border-b border-stone-200">
              <tr class="text-left text-[11px] uppercase tracking-wide text-stone-500">
                <th class="px-4 py-2 font-medium w-6"></th>
                <th class="px-4 py-2 font-medium">id</th>
                <th class="px-4 py-2 font-medium">customer</th>
                <th class="px-4 py-2 font-medium">product</th>
                <th class="px-4 py-2 font-medium">qty</th>
                <th class="px-4 py-2 font-medium">week</th>
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
      <span>Generated from Qlerify workflow <span class="mono">b0b1362b…</span>.</span>
      <span class="mx-2">·</span>
      <span>${state.events.length} events · ${BC_PANELS.length} systems · 16 aggregates</span>
    </footer>
  `;
}

function bindDashboard() {
  bindModelControls();
  document.getElementById("btn-new-demand")?.addEventListener("click", createDemand);
  document.querySelectorAll("[data-go]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.go));
  });
  document.querySelectorAll("[data-delete]").forEach((el) => {
    el.addEventListener("click", (ev) => deleteDemand(el.dataset.delete, ev));
  });
}

// ---------------------------------------------------------------------------
// Detail view (current 7-panel demo)
// ---------------------------------------------------------------------------

async function loadDetail() {
  const [events, snapshot, log, cur, demands] = await Promise.all([
    api("/sim/events"),
    api("/sim/snapshot?demandId=" + encodeURIComponent(state.demandId)),
    api("/sim/event-log?limit=200&demandId=" + encodeURIComponent(state.demandId)),
    api("/sim/current-step?demandId=" + encodeURIComponent(state.demandId)),
    api("/sim/demands"),
    loadRegistryStatus(),
  ]);
  state.events = events;
  state.prev = state.snapshot;
  state.snapshot = snapshot;
  state.log = log;
  state.currentIndex = cur.index;
  state.demands = demands;
  render();
}

async function doNext() {
  if (state.busy) return;
  state.busy = true; render();
  try {
    await api("/sim/next", {
      method: "POST",
      body: JSON.stringify({ demandId: state.demandId, withDisruptions: state.withDisruptions }),
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
      body: JSON.stringify({ demandId: state.demandId, withDisruptions: state.withDisruptions }),
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

function rowKey(row) { return row.id ?? JSON.stringify(row); }
function rowChanged(bc, tableName, row) {
  if (!state.prev) return false;
  const prev = state.prev?.[bc]?.[tableName]?.find((r) => rowKey(r) === rowKey(row));
  if (!prev) return true;
  return JSON.stringify(prev) !== JSON.stringify(row);
}

function pill(text, status) {
  const tone = STATUS_TONE[status] || "bg-stone-100 text-stone-700";
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${tone}">${text}</span>`;
}

function shortId(id) {
  if (!id) return "—";
  return String(id).length > 14 ? String(id).slice(0, 8) + "…" : id;
}

function tableHTML(bc, name, rows) {
  if (!rows || rows.length === 0) {
    return `<div class="text-[11px] text-stone-400 italic px-3 py-1.5">${name} — empty</div>`;
  }
  const cols = pickColumns(name, rows[0]);
  const head = cols.map((c) => `<th class="text-left font-medium text-stone-500 px-2 py-1">${c.label}</th>`).join("");
  const body = rows.map((row) => {
    const changed = rowChanged(bc, name, row);
    const tds = cols.map((c) => `<td class="px-2 py-1 align-top">${c.render(row) ?? "—"}</td>`).join("");
    return `<tr class="${changed ? "row-changed" : "hover:bg-stone-50"}">${tds}</tr>`;
  }).join("");
  return `
    <div class="overflow-hidden rounded-md border border-stone-200 bg-white">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-stone-500 px-3 py-1.5 bg-stone-50 border-b border-stone-200">${name} <span class="text-stone-400 font-normal">· ${rows.length} row${rows.length===1?"":"s"}</span></div>
      <table class="w-full text-[12px]"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div>
  `;
}

function pickColumns(name, sample) {
  const id = { label: "id", render: (r) => `<span class="mono text-stone-600">${shortId(r.id)}</span>` };
  const status = { label: "status", render: (r) => r.status ? pill(r.status, r.status) : "—" };
  switch (name) {
    case "demands":
      return [id, { label: "product", render: (r) => r.productName }, { label: "qty", render: (r) => r.qty }, { label: "week", render: (r) => r.requestedWeek }, status];
    case "projects":
      return [id, { label: "product", render: (r) => r.productName }, status];
    case "bomItems":
      return [id, { label: "part", render: (r) => `<span class="mono">${r.partNumber}</span>` }, { label: "qty/unit", render: (r) => r.qtyPerUnit }, { label: "design", render: (r) => pill(r.designState, r.designState) }];
    case "engineeringReleases":
      return [id, status, { label: "approvedAt", render: (r) => r.approvedAt ? r.approvedAt.slice(0,10) : "—" }];
    case "engineeringChanges":
      return [id, { label: "bom item", render: (r) => shortId(r.bomItemId) }, { label: "description", render: (r) => `<span class="text-stone-600">${r.description}</span>` }, status];
    case "buildPlans":
      return [id, { label: "v", render: (r) => `v${r.versionNo}` }, status, { label: "reason", render: (r) => r.reason ?? "—" }];
    case "builds":
      return [id, { label: "no", render: (r) => r.buildNo }, { label: "qty", render: (r) => r.qty }, { label: "site", render: (r) => r.siteId ? r.siteId.replace("site-","") : "—" }, { label: "material", render: (r) => pill(r.materialStatus, r.materialStatus) }, status];
    case "buildDemand":
      return [{ label: "part", render: (r) => `<span class="mono">${r.partNumber}</span>` }, { label: "req", render: (r) => r.qtyRequired }, { label: "avail", render: (r) => `<span class="${r.qtyAvailable >= r.qtyRequired ? "text-emerald-700 font-medium" : "text-stone-500"}">${r.qtyAvailable}</span>` }];
    case "purchaseOrders":
      return [id, { label: "part", render: (r) => `<span class="mono">${r.partNumber}</span>` }, { label: "qty", render: (r) => r.qty }, { label: "eta", render: (r) => r.confirmedEta ?? "—" }, status];
    case "workOrders":
      return [id, { label: "qty", render: (r) => r.qty }, status];
    case "sites":
      return [id, { label: "name", render: (r) => r.name }];
    case "lines":
      return [id, { label: "name", render: (r) => r.name }, { label: "cap/wk", render: (r) => r.capacityPerWeek }];
    case "bookings":
      return [id, { label: "line", render: (r) => r.lineId }, status];
    case "testResults":
      return [{ label: "type", render: (r) => pill(r.testType, r.testType) }, { label: "result", render: (r) => pill(r.result, r.result) }, { label: "serial", render: (r) => `<span class="mono">${r.unitSerial}</span>` }];
    case "units":
      return [{ label: "serial", render: (r) => `<span class="mono">${r.serialNo}</span>` }, status];
    case "shipments":
      return [id, { label: "units", render: (r) => (r.units || []).length }, status];
    default:
      return Object.keys(sample).slice(0, 4).map((k) => ({ label: k, render: (r) => String(r[k] ?? "—") }));
  }
}

function detailHeader() {
  const total = state.events.length;
  const cur = state.demands.find((d) => d.id === state.demandId);
  const headline = cur ? `${cur.qty} × ${cur.productName} for ${cur.customerId}` : "Demand";
  const subline = cur ? `requested week ${cur.requestedWeek} · ${cur.status}` : "";
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <button id="btn-back" class="p-1.5 -ml-1 rounded text-stone-500 hover:text-stone-900 hover:bg-stone-100" title="Back to dashboard">←</button>
        <div class="flex-1 min-w-0">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${state.demandId ? state.demandId.slice(0,16) + "…" : ""}</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">${headline}</div>
          <div class="text-xs text-stone-500">${subline}</div>
        </div>
        <div class="text-sm text-stone-500 mr-3 tabular-nums">step <span class="font-semibold text-stone-800">${state.currentIndex}</span> / ${total}</div>
        <div class="flex items-center gap-2">
          <label class="flex items-center gap-2 text-sm text-stone-600 cursor-pointer mr-2">
            <input id="disrupt" type="checkbox" ${state.withDisruptions ? "checked" : ""} class="accent-amber-500" />
            ⚠ Cascading disruptions
          </label>
          <button id="btn-reset" ${state.busy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Reset</button>
          <button id="btn-next"  ${state.busy || state.currentIndex >= total ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">Step forward →</button>
          <button id="btn-all"   ${state.busy || state.currentIndex >= total ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Run all</button>
          ${modelControls()}
          <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
        </div>
      </div>
    </header>
  `;
}

// Build a per-step lookup of the businessAt timestamp recorded when each step fired.
function businessByStep() {
  const m = new Map(); // eventRef → ISO businessAt
  for (const entry of state.log) {
    if (entry.businessAt && !m.has(entry.eventRef)) m.set(entry.eventRef, entry.businessAt);
  }
  return m;
}

function fmtBizDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  const ms = new Date(isoB).getTime() - new Date(isoA).getTime();
  return Math.round(ms / 86_400_000);
}

function timeline() {
  const total = state.events.length;
  const pct = total ? (state.currentIndex / total) * 100 : 0;
  const biz = businessByStep();
  let prevBizIso = null;

  const items = state.events.map((e, i) => {
    const fired = i < state.currentIndex;
    const isCurrent = i === state.currentIndex - 1;
    const phaseBorder = PHASE_TONE[e.phase] || "border-stone-300";
    const ringClass = isCurrent ? "ring-2 ring-amber-400" : "";

    const bizIso = biz.get(e.ref);
    const bizLabel = fired ? fmtBizDate(bizIso) : null;
    const gapDays = fired && prevBizIso && bizIso ? daysBetween(prevBizIso, bizIso) : null;
    if (fired && bizIso) prevBizIso = bizIso;

    // Highlight long gaps (>10 days) in amber so the supplier-slip moment pops.
    const gapTone = gapDays != null && gapDays >= 10 ? "text-amber-700 font-semibold" : "text-stone-500";

    return `
      <div data-step="${i}" class="shrink-0 w-44 rounded-md border ${phaseBorder} ${ringClass} bg-white px-3 py-2 ${fired ? "" : "opacity-60"} flex flex-col">
        <div class="flex items-center justify-between text-[10px] text-stone-500 mb-0.5">
          <span>${i+1}. ${e.boundedContext}</span>
          ${e.derived ? `<span class="text-amber-600 font-semibold">DERIVED</span>` : ""}
        </div>
        <div class="text-[12px] font-medium leading-tight text-stone-800">${e.name}</div>
        <div class="text-[10px] text-stone-500 mt-1">${e.role}</div>
        ${fired ? `
          <div class="mt-auto pt-1.5 border-t border-stone-100 flex items-baseline justify-between text-[10px]">
            <span class="text-stone-700 font-medium">${bizLabel ?? "—"}</span>
            ${gapDays != null && gapDays > 0 ? `<span class="${gapTone}">+${gapDays}d</span>` : ""}
          </div>
        ` : ""}
      </div>
    `;
  }).join("");
  return `
    <section class="border-b border-stone-200 bg-stone-50">
      <div id="timeline-scroll" class="px-6 py-3 overflow-x-auto">
        <div class="inline-flex flex-col gap-2" style="width: max-content;">
          <div class="grid gap-0" style="grid-template-columns: repeat(${total}, 11rem);">${items}</div>
          <div class="h-1 bg-stone-200 rounded overflow-hidden">
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
          <div class="font-medium text-stone-900">${last.eventName}</div>
          <div class="text-sm text-stone-600 mt-0.5">
            <span class="mono text-stone-500">${last.boundedContext}</span> · ${last.role} ·
            <span class="text-stone-500">${new Date(last.occurredAt).toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bcPanel(panel) {
  if (!state.snapshot) return "";
  const data = state.snapshot[panel.bc] || {};
  const last = state.log[0];
  const isActive = last && last.boundedContext === panel.bc;
  const tables = panel.tables.map((t) => tableHTML(panel.bc, t, data[t] || [])).join("");
  return `
    <div class="panel ${isActive ? "active" : ""} flex flex-col gap-2 p-3 rounded-lg border border-stone-200 bg-white shadow-sm">
      <div class="flex items-baseline justify-between">
        <div>
          <div class="font-semibold text-stone-800">${panel.title}</div>
          <div class="text-[11px] text-stone-500">${panel.subtitle}</div>
        </div>
        ${isActive ? `<span class="text-[10px] uppercase tracking-widest text-amber-700 font-bold">active</span>` : ""}
      </div>
      <div class="flex flex-col gap-2">${tables}</div>
    </div>
  `;
}

function detailView() {
  return `
    ${detailHeader()}
    ${timeline()}
    ${lastEventCaption()}
    <main class="flex-1 overflow-auto p-6">
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        ${BC_PANELS.map(bcPanel).join("")}
      </div>
    </main>
    <footer class="px-6 py-3 text-xs text-stone-500 border-t border-stone-200 bg-stone-50">
      <span>Generated from Qlerify workflow <span class="mono">b0b1362b…</span>.</span>
      <span class="mx-2">·</span>
      <span>${state.events.length} events · ${BC_PANELS.length} systems · 16 aggregates</span>
    </footer>
  `;
}

function bindDetail() {
  bindModelControls();
  document.getElementById("btn-back")?.addEventListener("click", () => navigate("#"));
  document.getElementById("btn-next")?.addEventListener("click", doNext);
  document.getElementById("btn-all")?.addEventListener("click", doRunAll);
  document.getElementById("btn-reset")?.addEventListener("click", doReset);
  document.getElementById("disrupt")?.addEventListener("change", (e) => {
    state.withDisruptions = e.target.checked;
  });
}

// ---------------------------------------------------------------------------
// Render dispatcher
// ---------------------------------------------------------------------------

function render() {
  const prevScroll = document.getElementById("timeline-scroll")?.scrollLeft ?? 0;
  const prevDialogScroll = document.getElementById("model-file-scroll")?.scrollTop ?? 0;
  const mainShiftCls = state.chatOpen ? "mr-[420px]" : "";

  if (state.view === "detail") {
    root.innerHTML = `<div class="${mainShiftCls} flex flex-col min-h-screen transition-[margin-right] duration-200">${registryBanner()}${detailView()}</div>${chatPanel()}${modelToast()}${modelFileDialog()}`;
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
  } else {
    root.innerHTML = `<div class="${mainShiftCls} flex flex-col min-h-screen transition-[margin-right] duration-200">${registryBanner()}${dashboardView()}</div>${chatPanel()}${modelToast()}${modelFileDialog()}`;
    bindDashboard();
    bindChat();
  }

  // Preserve the model viewer's scroll position across re-renders so polling /
  // toasts don't yank the user back to the top while they're reading.
  if (prevDialogScroll) {
    const dlg = document.getElementById("model-file-scroll");
    if (dlg) dlg.scrollTop = prevDialogScroll;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

window.addEventListener("hashchange", onHashChange);
onHashChange().catch((e) => {
  root.innerHTML = `<div class="p-8 text-rose-700">Failed to load: ${e.message}</div>`;
});
