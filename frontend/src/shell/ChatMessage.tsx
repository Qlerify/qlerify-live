import { Markdown } from "@/components/Markdown.tsx"
import type { ChatBlock, ChatMessage as Msg } from "@/lib/types.ts"

const WRITE_TOOLS = new Set([
  "next_step",
  "create_case",
  "regenerate_adapter_body",
  "reset_adapter",
  "create_connector",
  "build_connector",
  "ingest_connector",
  "remove_connector",
])

const Bubble = ({ children }: { children: React.ReactNode }) => (
  <div className="flex justify-end">
    <div className="max-w-[85%] min-w-0 break-words bg-stone-900 text-white px-3 py-2 rounded-2xl rounded-tr-md text-sm">{children}</div>
  </div>
)

const ToolResult = ({ block }: { block: ChatBlock }) => {
  const text =
    typeof block.content === "string"
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((c) => c.text || "").join("")
        : ""
  const tone = block.is_error
    ? "border-rose-200 bg-rose-50 text-rose-800"
    : "border-stone-200 bg-stone-50 text-stone-600"
  const trimmed = text.length > 220 ? `${text.slice(0, 220)}…` : text
  return (
    <details className={`text-[11px] break-words ${tone} border rounded px-2 py-1 my-1`}>
      <summary className="cursor-pointer select-none">
        {block.is_error ? "❌" : "↩"} tool result <span className="text-stone-400">({text.length} chars)</span>
      </summary>
      <pre className="mono text-[11px] whitespace-pre-wrap mt-1">{trimmed}</pre>
    </details>
  )
}

const ToolUse = ({ block }: { block: ChatBlock }) => {
  const args = JSON.stringify(block.input, null, 2) ?? ""
  const preview = args.length > 120 ? `${args.slice(0, 120)}…` : args
  const tone = WRITE_TOOLS.has(block.name || "") ? "border-amber-300 bg-amber-50" : "border-stone-200 bg-stone-50"
  return (
    <details className={`text-[11px] break-words ${tone} border rounded px-2 py-1 my-1`}>
      <summary className="cursor-pointer select-none text-stone-700">
        🔧 <b>{block.name}</b> <span className="text-stone-400 mono">{preview}</span>
      </summary>
      <pre className="mono text-[11px] whitespace-pre-wrap mt-1 text-stone-600">{args}</pre>
    </details>
  )
}

export const ChatMessage = ({ msg }: { msg: Msg }) => {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return (
        <Bubble>
          <Markdown text={msg.content} />
        </Bubble>
      )
    }
    const blocks = msg.content || []
    // The injected [Context: …] prefix is for the model, not the user.
    const texts = blocks.filter((b) => b.type === "text" && !String(b.text).startsWith("[Context:"))
    if (texts.length) {
      return (
        <Bubble>
          {texts.map((b, i) => (
            <Markdown key={i} text={b.text || ""} />
          ))}
        </Bubble>
      )
    }
    const results = blocks.filter((b) => b.type === "tool_result")
    if (!results.length) {
      return null
    }
    return (
      <>
        {results.map((b, i) => (
          <ToolResult key={i} block={b} />
        ))}
      </>
    )
  }

  const blocks = Array.isArray(msg.content) ? msg.content : []
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] min-w-0 break-words">
        <div className="text-[10px] uppercase tracking-widest text-stone-400 mb-0.5">assistant</div>
        {blocks.map((b, i) => {
          if (b.type === "text") {
            return (
              <div key={i} className="text-sm text-stone-800">
                <Markdown text={b.text || ""} />
              </div>
            )
          }
          if (b.type === "tool_use") {
            return <ToolUse key={i} block={b} />
          }
          if (b.type === "thinking") {
            return (
              <div key={i} className="text-[10px] text-stone-400 italic my-0.5">
                thinking…
              </div>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
