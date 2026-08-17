import { useEffect, useRef } from "react"
import { activateConnectorChat, clearChat, lastAssistantAsksConfirmation, sendChat, toggleChat } from "@/lib/chatData.ts"
import { useStore } from "@/lib/store.ts"
import { EventLogBody } from "@/views/Detail/EventLogBody.tsx"
import { ConnectorHistoryBody } from "@/views/Explorer/ConnectorHistoryBody.tsx"
import { ChatMessage } from "./ChatMessage.tsx"
import { ChatProgress } from "./ChatProgress.tsx"

const ADVISOR_EXAMPLES = [
  "How many cases haven't moved in 24h?",
  "Which case is closest to being delivered?",
  "Are any cases stuck at the same step?",
  "Create a new case.",
]

const DETAIL_EXAMPLES = [
  "Explain the next step in this workflow!",
  "Explain the last thing that was completed on this workflow.",
  "Why hasn't this case moved forward yet?",
  "Move this case forward one step.",
]

const MAX_INPUT_PX = 260

const BUILDER_EXAMPLES = [
  "Simulate content",
  "Fill this table from our DynamoDB users table",
  "Connect this to a REST API and pull the records",
  "Populate this from a Postgres query",
]

export const ChatPanel = ({ view }: { view: string }) => {
  const {
    chatOpen,
    chatInfo,
    chatMessages,
    chatInput,
    chatBusy,
    chatError,
    detailPanelMode,
    expPanelMode,
    exp,
    set,
  } = useStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const builder = view === "bcs"
  const detail = view === "detail"
  const mode = builder ? expPanelMode : detail ? detailPanelMode : "chat"

  useEffect(() => {
    if (chatOpen && mode === "chat") {
      inputRef.current?.focus()
    }
  }, [chatOpen, mode])

  useEffect(() => {
    const el = inputRef.current
    if (!el) {
      return
    }
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`
  }, [chatInput, chatOpen, mode])

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [chatMessages, chatBusy])

  if (!chatOpen) {
    return null
  }

  const apiOk = chatInfo?.apiKeyConfigured
  const tabBtn = (m: string, label: string) => (
    <button
      onClick={() => set(builder ? { expPanelMode: m } : { detailPanelMode: m })}
      className={`flex-1 text-xs py-1 rounded ${mode === m ? "bg-white text-stone-900 shadow-sm font-medium" : "text-stone-500 hover:text-stone-700"}`}
    >
      {label}
    </button>
  )

  const header = (
    <div className="px-4 py-3 border-b border-stone-200">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Assistant</div>
          <div className="text-sm text-stone-800 font-medium">
            {builder ? "Connector builder" : detail && mode === "log" ? "Event log" : "Process advisor"}
          </div>
        </div>
        {mode === "chat" &&
          (chatInfo ? (
            apiOk ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                {chatInfo.model} · {chatInfo.effort}
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-800">no api key</span>
            )
          ) : (
            <span className="text-[10px] text-stone-400">loading…</span>
          ))}
        {mode === "chat" && (
          <button onClick={clearChat} title="Clear conversation" className="text-stone-400 hover:text-stone-700 text-sm">
            ↺
          </button>
        )}
        <button onClick={toggleChat} title="Close" className="text-stone-400 hover:text-stone-700 text-lg leading-none">
          ×
        </button>
      </div>
      {builder && (
        <div className="flex gap-1 mt-2 bg-stone-100 rounded-md p-0.5">
          {tabBtn("history", "History")}
          {tabBtn("chat", "Chat")}
        </div>
      )}
      {detail && (
        <div className="flex gap-1 mt-2 bg-stone-100 rounded-md p-0.5">
          {tabBtn("chat", "Assistant")}
          {tabBtn("log", "Event log")}
        </div>
      )}
    </div>
  )

  const shell = (body: React.ReactNode) => (
    <aside className="fixed top-0 right-0 bottom-0 w-[420px] bg-white border-l border-stone-200 shadow-xl flex flex-col z-30">
      {header}
      {body}
    </aside>
  )

  if (builder && mode === "history") {
    return shell(<ConnectorHistoryBody exp={exp} onBuild={() => activateConnectorChat(exp.system, exp.entity)} />)
  }
  if (detail && mode === "log") {
    return shell(<EventLogBody />)
  }

  const examples = detail ? DETAIL_EXAMPLES : builder ? BUILDER_EXAMPLES : ADVISOR_EXAMPLES
  const empty = chatMessages.length === 0

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendChat()
    }
  }

  return shell(
    <>
      {!apiOk && chatInfo && (
        <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 text-[12px] text-amber-900">
          <b>No AI provider configured.</b> Choose one in <b>Org Admin → AI · LLM provider</b> (an Anthropic API key, or
          AWS Bedrock with your own AWS credentials), or add <span className="mono">ANTHROPIC_API_KEY</span> to{" "}
          <span className="mono">.env</span> and restart the server.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        {empty ? (
          <div className="text-stone-500 text-sm">
            {builder ? (
              <>
                Describe any source — DynamoDB, a REST API, Postgres, a Google Sheet — and I'll write a connector to
                fill <b>{exp.entity || "this table"}</b>, test it, fix any errors, and populate it. I'll confirm before
                each change. Past activity for this connector is on the <b>History</b> tab.
              </>
            ) : (
              "Ask about cases, the workflow, or have me advance a step. I'll always confirm before changing anything."
            )}
            <div className="mt-3 flex flex-col gap-1.5">
              {examples.map((q) => (
                <button
                  key={q}
                  onClick={() => sendChat(q)}
                  className="text-left text-[12px] text-stone-700 hover:bg-stone-100 rounded px-2 py-1 border border-stone-200"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          chatMessages.map((m, i) => <ChatMessage key={i} msg={m} />)
        )}
        {chatBusy && <ChatProgress />}
        {chatError && <div className="text-rose-700 text-xs">⚠ {chatError}</div>}
        {!empty && !chatBusy && lastAssistantAsksConfirmation(chatMessages) && (
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={() => sendChat("Yes, proceed.")}
              className="px-3 py-1.5 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 font-medium"
            >
              Yes, proceed
            </button>
            <button
              onClick={() => sendChat("No, don't proceed.")}
              className="px-3 py-1.5 text-xs rounded-md bg-white border border-stone-300 text-stone-700 hover:bg-stone-100 font-medium"
            >
              No
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-stone-200 p-3">
        <textarea
          ref={inputRef}
          value={chatInput}
          onChange={(e) => set({ chatInput: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder="Ask anything about cases or the workflow…"
          className="w-full text-sm border border-stone-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-400 focus:border-amber-400 resize-none min-h-[96px] overflow-y-auto"
        />
        <div className="flex items-center gap-2 mt-2">
          <div className="flex-1 text-[10px] text-stone-400">Enter to send · Shift+Enter for new line</div>
          <button
            onClick={() => sendChat()}
            disabled={chatBusy || !chatInput.trim()}
            className="px-3 py-1.5 text-xs rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium"
          >
            Send →
          </button>
        </div>
      </div>
    </>,
  )
}
