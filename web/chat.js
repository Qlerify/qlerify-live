// Chat & connector-builder panel — the AI assistant surface (advisor + per-table
// connector threads), its message rendering, and the event-log tab. Extracted
// from app.js; shared services (api/render/navigate/AUTH + a few loaders) are
// imported from ./app.js — safe because they are only called at runtime.
import { state } from "./state.js";
import { escapeHtml, prettyEntity, renderTextContent } from "./format.js";
import { EVIDENCE_KIND, evidenceChip, provChip } from "./chips.js";
import { AUTH, api, render } from "./app.js";
import { loadDashboard } from "./dashboard.js";
import { loadDetail } from "./detail.js";
import { connectorHistoryBody, expKindOf, refreshExplorerAfterChat } from "./explorer.js";

// ---------------------------------------------------------------------------
// Chat panel
// ---------------------------------------------------------------------------

export async function loadChatInfo() {
  try {
    state.chatInfo = await api("/chat/info");
  } catch (e) {
    state.chatInfo = { apiKeyConfigured: false, error: e.message };
  }
}

export function toggleChat() {
  state.chatOpen = !state.chatOpen;
  if (state.chatOpen && !state.chatInfo) loadChatInfo().then(render);
  render();
  if (state.chatOpen) setTimeout(() => document.getElementById("chat-input")?.focus(), 30);
}

export async function sendChat() {
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

  // Identity of the thread this turn belongs to. If the user switches workflow
  // or table while the turn is in flight, the live thread is swapped out — the
  // response must go to THIS thread's stash, not clobber (or persist under) the
  // newly active one.
  const scopeAtSend = state.chatScope;
  const wasConnector = state.inConnectorMode;
  const keyAtSend = state.connectorChatKey;

  try {
    const resp = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ messages: state.chatMessages }),
    });
    const swapped = state.chatScope !== scopeAtSend
      || state.inConnectorMode !== wasConnector
      || state.connectorChatKey !== keyAtSend;
    if (swapped) {
      // File the completed turn where it belongs (in-memory only — the request
      // headers for a server persist would now name the wrong workflow).
      if (wasConnector) state.connectorChats[keyAtSend] = resp.messages;
      else state.advisorChats[scopeAtSend] = resp.messages;
      return; // finally still clears busy + renders
    }
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

export function clearChat() {
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

// --- Connector-builder threads: one per (workflow, system, table) -----------
// state.chatMessages is shared with the dashboard/detail advisor, so we model
// two stashes: per-(system,table) connector threads and per-scope advisor
// threads. activate/deactivate swap the live thread in/out; stashActiveChat
// always saves the LIVE state.chatMessages first (sendChat reassigns that array
// each turn, so the map ref can be stale between turns — re-stashing on every
// swap keeps it correct).
//
// Every key is prefixed with chatScope() — the active org + workflow — because
// switching workflow (or org) is SPA-style with no reload. The server persists
// connector threads per workflow (journal.ts connectorChatKey), but an unscoped
// client cache would show workflow A's thread inside workflow B whenever both
// share a model's system/table names (e.g. two workflows connected to the same
// Qlerify source), and the next turn would persist A's thread under B's server
// key — the cross-workflow history bleed. AUTH.setOrg/setWorkflow call
// syncChatScope() so every switch path swaps the threads.
export function chatScope() {
  return `${AUTH.org()}::${AUTH.workflow()}`;
}

export function connectorChatKey(system, entity) {
  return `${chatScope()}::${system || ""}::${entity || ""}`;
}

// The org/workflow changed: stash the live thread under the scope it belongs to
// (its keys were captured when it went live), then swap in the new scope's
// thread. Render-free — every switch path re-renders afterwards anyway.
export function syncChatScope() {
  const scope = chatScope();
  if (state.chatScope === scope) return;
  stashActiveChat();
  state.chatScope = scope;
  state.chatError = null;
  if (state.inConnectorMode && state.exp?.system && state.exp?.entity) {
    // Still in the explorer: re-point the live thread at the SAME table in the
    // NEW workflow (empty until its server-persisted copy hydrates).
    const nk = connectorChatKey(state.exp.system, state.exp.entity);
    state.connectorChatKey = nk;
    state.chatMessages = state.connectorChats[nk] || [];
    hydrateConnectorChat(state.exp.system, state.exp.entity, nk);
  } else {
    state.inConnectorMode = false;
    state.connectorChatKey = null;
    state.chatMessages = state.advisorChats[scope] || [];
  }
}

// Logout: a different identity may sign in next on this page — drop every thread.
export function resetChatState() {
  state.chatMessages = [];
  state.chatInput = "";
  state.chatError = null;
  state.advisorChats = {};
  state.connectorChats = {};
  state.connectorChatsHydrated = new Set();
  state.inConnectorMode = false;
  state.connectorChatKey = null;
  state.chatScope = null;
}

export function stashActiveChat() {
  if (state.inConnectorMode) state.connectorChats[state.connectorChatKey] = state.chatMessages;
  else state.advisorChats[state.chatScope ?? chatScope()] = state.chatMessages;
}

// Make the connector thread for (system, entity) the active chat. No-op if it is
// already active. Stashes whatever thread is currently live first, then lazily
// hydrates from the server-persisted copy.
export function activateConnectorChat(system, entity) {
  const nk = connectorChatKey(system, entity);
  if (state.inConnectorMode && state.connectorChatKey === nk) return;
  stashActiveChat();
  state.inConnectorMode = true;
  state.connectorChatKey = nk;
  state.chatScope = chatScope();
  state.chatMessages = state.connectorChats[nk] || [];
  state.chatError = null;
  hydrateConnectorChat(system, entity, nk);
}

// Load the server-persisted thread for a connector key the first time it becomes
// active this session. Adopts the server copy only when we have no local thread
// for it yet (never clobbers an in-progress conversation) and the key is still
// the active one when the response lands.
export async function hydrateConnectorChat(system, entity, nk) {
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
export function persistConnectorChat() {
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
export function deactivateConnectorChat() {
  if (!state.inConnectorMode) return;
  stashActiveChat();
  state.inConnectorMode = false;
  state.connectorChatKey = null;
  state.chatScope = chatScope();
  state.chatMessages = state.advisorChats[chatScope()] || [];
  state.chatError = null;
}

export function scrollChatToBottom() {
  setTimeout(() => {
    const el = document.getElementById("chat-scroll");
    if (el) el.scrollTop = el.scrollHeight;
  }, 30);
}

export function chatMessageHtml(m) {
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
export const CONFIRM_RE = /\b(shall i (?:proceed|continue|go ahead)|should i (?:proceed|continue|go ahead)|do you want me to (?:proceed|continue|go ahead)|want me to (?:proceed|go ahead)|ready to proceed|proceed\?|confirm\?|go ahead\?)/i;

export function lastAssistantAsksConfirmation() {
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
export function confirmQuickReplies() {
  return `
    <div class="flex flex-wrap gap-2 pt-1">
      <button data-quick-reply="Yes, proceed." class="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 font-medium">Yes, proceed</button>
      <button data-quick-reply="No, don't proceed." class="px-3 py-1.5 text-xs rounded-md bg-white border border-stone-300 text-stone-700 hover:bg-stone-100 font-medium">No</button>
    </div>`;
}

export function chatPanel() {
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
    "Simulate content",
    "Fill this table from our DynamoDB users table",
    "Connect this to a REST API and pull the records",
    "Populate this from a Postgres query",
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
export function eventLogBody() {
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

export function bindChat() {
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
