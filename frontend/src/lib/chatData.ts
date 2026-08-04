import { AUTH, api, apiStream } from "./api.ts"
import { useStore } from "./store.ts"
import { loadDashboard } from "./workflowData.ts"
import { loadDetail } from "./detailData.ts"
import { kindOf, refreshExplorer } from "./explorerData.ts"
import { parseHash } from "./router.ts"
import type { ChatBlock, ChatInfo, ChatMessage } from "./types.ts"

// Thread stashes. These are caches, not rendered state — only the live thread
// (store.chatMessages) reaches the UI, so they stay out of the store.
let advisorChats: Record<string, ChatMessage[]> = {}
let connectorChats: Record<string, ChatMessage[]> = {}
let hydrated = new Set<string>()
let inConnectorMode = false
let activeKey: string | null = null
let activeScope: string | null = null

// Turn-in-flight plumbing. Module-local: nothing renders from these, they only
// steer the one live request.
let chatAbort: AbortController | null = null
let chatStopRequested = false // distinguishes a user Stop from a network abort
let chatTurnGen = 0 // bumped by disownChatTurn; a stale gen = discard the turn

// User pressed Stop: cancel the request but keep the turn OWNED, so its
// catch/finally report "Stopped" and clean up state.
export const stopChat = () => {
  chatStopRequested = true
  chatAbort?.abort()
}

// The active thread was discarded (clear button, logout/reset) while a turn was
// in flight: cancel it AND disown it — its response must not resurrect the
// cleared thread, and its error must not pollute the fresh state. sendChat's gen
// checks make the orphaned continuation a no-op, so busy/progress are cleared
// here instead of in its finally.
const disownChatTurn = () => {
  chatTurnGen++
  useStore.getState().set({ chatBusy: false, chatProgress: null })
  chatAbort?.abort()
}

// Every key is prefixed with the active org + workflow. Switching workflow is
// SPA-style with no reload, so an unscoped cache would show workflow A's thread
// inside workflow B whenever both share a model's system/table names — and the
// next turn would persist A's thread under B's server key.
export const chatScope = () => `${AUTH.org()}::${AUTH.workflow()}`

export const connectorChatKey = (system?: string | null, entity?: string | null) =>
  `${chatScope()}::${system || ""}::${entity || ""}`

export const isConnectorMode = () => inConnectorMode

export const loadChatInfo = async () => {
  const set = useStore.getState().set
  try {
    set({ chatInfo: await api<ChatInfo>("/chat/info") })
  } catch (e) {
    set({ chatInfo: { apiKeyConfigured: false, error: (e as Error).message } })
  }
}

export const openChat = () => {
  const s = useStore.getState()
  s.set({ chatOpen: true })
  if (!s.chatInfo) {
    loadChatInfo()
  }
}

export const toggleChat = () => {
  const s = useStore.getState()
  s.set({ chatOpen: !s.chatOpen })
  if (!s.chatOpen && !s.chatInfo) {
    loadChatInfo()
  }
}

// sendChat reassigns chatMessages each turn, so the stash refs go stale between
// turns — always re-stash the LIVE array on every swap.
export const stashActiveChat = () => {
  const msgs = useStore.getState().chatMessages
  if (inConnectorMode && activeKey) {
    connectorChats[activeKey] = msgs
  } else {
    advisorChats[activeScope ?? chatScope()] = msgs
  }
}

// Adopt the server-persisted thread the first time a connector key goes live this
// session — only when we have no local thread for it (never clobbers an
// in-progress conversation) and it is still the active key when the reply lands.
const hydrateConnectorChat = async (system: string, entity: string, key: string) => {
  if (hydrated.has(key)) {
    return
  }
  hydrated.add(key)
  try {
    const d = await api<{ messages?: ChatMessage[] }>(
      `/api/bc/${encodeURIComponent(system)}/connector-chat?target=${encodeURIComponent(entity)}`,
    )
    const msgs = d.messages || []
    const local = connectorChats[key]
    if (msgs.length && (!local || local.length === 0)) {
      connectorChats[key] = msgs
      if (activeKey === key) {
        useStore.getState().set({ chatMessages: msgs })
      }
    }
  } catch {
    hydrated.delete(key) // allow a retry on next activation
  }
}

export const activateConnectorChat = (system?: string | null, entity?: string | null) => {
  const key = connectorChatKey(system, entity)
  if (inConnectorMode && activeKey === key) {
    return
  }
  stashActiveChat()
  inConnectorMode = true
  activeKey = key
  activeScope = chatScope()
  useStore.getState().set({ chatMessages: connectorChats[key] || [], chatError: null })
  if (system && entity) {
    hydrateConnectorChat(system, entity, key)
  }
}

// Leave builder mode: save the connector thread, restore the advisor thread.
export const deactivateConnectorChat = () => {
  if (!inConnectorMode) {
    return
  }
  stashActiveChat()
  inConnectorMode = false
  activeKey = null
  activeScope = chatScope()
  useStore.getState().set({ chatMessages: advisorChats[activeScope] || [], chatError: null })
}

// The org/workflow changed: stash the live thread under the scope it belongs to,
// then swap in the new scope's thread.
export const syncChatScope = () => {
  const scope = chatScope()
  if (activeScope === scope) {
    return
  }
  stashActiveChat()
  activeScope = scope
  const e = useStore.getState().exp
  if (inConnectorMode && e.system && e.entity) {
    // Still in the explorer: re-point at the SAME table in the NEW workflow.
    const key = connectorChatKey(e.system, e.entity)
    activeKey = key
    useStore.getState().set({ chatMessages: connectorChats[key] || [], chatError: null })
    hydrateConnectorChat(e.system, e.entity, key)
    return
  }
  inConnectorMode = false
  activeKey = null
  useStore.getState().set({ chatMessages: advisorChats[scope] || [], chatError: null })
}

// Logout: a different identity may sign in next on this page — drop every thread.
export const resetChatState = () => {
  disownChatTurn() // its late continuation must not touch the fresh state
  advisorChats = {}
  connectorChats = {}
  hydrated = new Set()
  inConnectorMode = false
  activeKey = null
  activeScope = null
  useStore.getState().set({ chatMessages: [], chatInput: "", chatError: null })
}

// Persist the active connector thread (fire-and-forget) so it survives a reload.
const persistConnectorChat = () => {
  const s = useStore.getState()
  const e = s.exp
  if (!inConnectorMode || !activeKey || !e.system || !e.entity) {
    return
  }
  hydrated.add(activeKey) // we are now the source of truth
  api(`/api/bc/${encodeURIComponent(e.system)}/connector-chat`, {
    method: "PUT",
    body: JSON.stringify({ target: e.entity, messages: s.chatMessages }),
  }).catch(() => {})
}

export const clearChat = () => {
  disownChatTurn() // an in-flight turn must not resurrect (or re-persist) the cleared thread
  const s = useStore.getState()
  const e = s.exp
  if (inConnectorMode && activeKey && e.system && e.entity) {
    connectorChats[activeKey] = []
    hydrated.add(activeKey) // server now empty; don't re-hydrate
    api(`/api/bc/${encodeURIComponent(e.system)}/connector-chat?target=${encodeURIComponent(e.entity)}`, {
      method: "DELETE",
    }).catch(() => {})
  }
  s.set({ chatMessages: [], chatError: null })
}

// The assistant never sees the URL, so phrases like "this case" or "this table"
// need the view's selection spelled out as a context block.
const contextualContent = (text: string): string | ChatBlock[] => {
  const s = useStore.getState()
  const route = parseHash()

  if (route.view === "detail" && route.caseId) {
    const cur = s.cases.find((d) => d.id === route.caseId)
    const desc = cur ? `status ${cur.status ?? "—"}` : "(unknown)"
    return [
      {
        type: "text",
        text: `[Context: viewing case ${route.caseId} — ${desc}. When the user says "this case", "it", or refers to a step without naming a case, they mean this one.]`,
      },
      { type: "text", text },
    ]
  }

  const e = s.exp
  if (route.view === "bcs" && e.system) {
    const kind = kindOf(e, e.entity) === "valueObject" ? "value object" : "entity"
    const conns = (e.adapters || []).map((a) => `${a.id} (${a.kind}/${a.mode}→${a.targetEntity})`).join(", ") || "none"
    // The selected table's recent update notes — the same History-tab log — so
    // the assistant knows about prior work without a tool call.
    const sel = (e.adapters || []).find((a) => a.targetEntity === e.entity)
    const recent = (sel?.doc?.notes || [])
      .slice(-3)
      .map((n) => `${n.kind}: ${n.text}`)
      .join("; ")
    const hist = recent
      ? ` Recent activity on this table's connector — ${recent}. Call get_connector_history for the full log.`
      : ""
    const ctx = `[Context: in the Systems explorer. System (bounded context): ${e.system}. Selected table: ${e.entity || "(none)"} — a model ${kind}. Existing connectors/adapters on this system: ${conns}.${hist} When the user says "this table", "this", "it", or "fill this", they mean the selected table — build or repair a connector that populates it, following the Connector Builder loop. Confirm before create/build/ingest.]`
    return [{ type: "text", text: ctx }, { type: "text", text }]
  }

  return text
}

// SSE progress events reshape the live indicator under the messages.
const onChatProgress = (name: string, data: any) => {
  const p = useStore.getState().chatProgress
  if (name !== "progress" || !p) {
    return
  }
  if (data.kind === "model_call") {
    useStore.getState().set({ chatProgress: { ...p, iteration: data.iteration, tool: null } })
  } else if (data.kind === "tool_start") {
    useStore.getState().set({ chatProgress: { ...p, tool: data.name } })
  } else if (data.kind === "tool_end") {
    useStore.getState().set({ chatProgress: { ...p, toolsDone: p.toolsDone + 1, tool: null } })
  }
}

export const sendChat = async (override?: string) => {
  const s = useStore.getState()
  const text = (override ?? s.chatInput).trim()
  if (!text || s.chatBusy) {
    return
  }

  const messages = [...s.chatMessages, { role: "user", content: contextualContent(text) }]
  s.set({
    chatMessages: messages,
    chatInput: "",
    chatBusy: true,
    chatError: null,
    chatProgress: { startedAt: Date.now(), tool: null, iteration: 1, toolsDone: 0 },
  })

  chatStopRequested = false
  // Keep this turn's own controller in a local: after a disown a NEWER turn may
  // already own the module slot, and this turn's finally must tear down only its
  // own instance, never the successor's.
  const myAbort = new AbortController()
  chatAbort = myAbort
  const genAtSend = chatTurnGen

  // Identity of the thread this turn belongs to. If the user switches workflow or
  // table mid-flight, the reply must go to THIS thread's stash rather than
  // clobber (or persist under) the newly active one.
  const scopeAtSend = activeScope
  const wasConnector = inConnectorMode
  const keyAtSend = activeKey

  try {
    const resp = await apiStream<{ messages: ChatMessage[] }>("/chat", {
      body: JSON.stringify({ messages }),
      signal: myAbort.signal,
      onEvent: onChatProgress,
    })
    // Disowned (thread cleared / state reset mid-turn): the user discarded this
    // conversation — drop the response entirely, unlike a swap which files it.
    if (chatTurnGen !== genAtSend) {
      return
    }
    const swapped = activeScope !== scopeAtSend || inConnectorMode !== wasConnector || activeKey !== keyAtSend
    if (swapped) {
      // File the completed turn where it belongs — in memory only, since a server
      // persist would now carry headers naming the wrong workflow.
      if (wasConnector && keyAtSend) {
        connectorChats[keyAtSend] = resp.messages
      } else {
        advisorChats[scopeAtSend ?? chatScope()] = resp.messages
      }
      return
    }
    useStore.getState().set({ chatMessages: resp.messages })

    // Write tools may have moved the data the current view is showing.
    const route = parseHash()
    if (route.view === "dashboard") {
      await loadDashboard()
    } else if (route.view === "detail" && route.caseId) {
      await loadDetail(route.caseId)
    } else if (route.view === "bcs") {
      await refreshExplorer()
      persistConnectorChat()
    }
  } catch (e) {
    // A disowned turn reports nothing — the thread it belonged to is gone.
    if (chatTurnGen === genAtSend) {
      // "Stopped" only for the user's own Stop (an abort), never for a real
      // failure that happens to arrive while the flag is set — e.g. the 401
      // session-expiry path, which resets chat state mid-flight.
      const stopped = chatStopRequested && (e as Error)?.name === "AbortError"
      useStore.getState().set({
        chatError: stopped ? "Stopped — the reply was cancelled before it finished." : (e as Error).message,
      })
    }
  } finally {
    if (chatAbort === myAbort) {
      chatAbort = null
    }
    if (chatTurnGen === genAtSend) {
      useStore.getState().set({ chatBusy: false, chatProgress: null })
    }
  }
}

// The assistant follows a "confirm before any write" policy — it asks "Shall I
// proceed?" and stops. When its last message is one of those pauses we offer
// one-click Yes/No replies instead of making the user type.
const CONFIRM_RE =
  /\b(shall i (?:proceed|continue|go ahead)|should i (?:proceed|continue|go ahead)|do you want me to (?:proceed|continue|go ahead)|want me to (?:proceed|go ahead)|ready to proceed|proceed\?|confirm\?|go ahead\?)/i

export const lastAssistantAsksConfirmation = (msgs: ChatMessage[]) => {
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== "assistant") {
    return false
  }
  const blocks = Array.isArray(last.content) ? last.content : []
  // A pending tool_use means the loop is still mid-flight — only offer the
  // buttons when the turn actually ended on the question.
  if (blocks.some((b) => b.type === "tool_use")) {
    return false
  }
  return CONFIRM_RE.test(
    blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" "),
  )
}
