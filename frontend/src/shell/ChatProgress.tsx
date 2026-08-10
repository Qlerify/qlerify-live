import { useEffect, useState } from "react"
import { stopChat } from "@/lib/chatData.ts"
import { useStore } from "@/lib/store.ts"

// The live line under the messages while a turn runs: current activity (model
// thinking vs a named tool), step/tool-call counts once there's more than one,
// and elapsed time. The 1s ticker lives here so only this subtree re-renders.
export const ChatProgress = () => {
  const p = useStore((s) => s.chatProgress)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const body = () => {
    if (!p) {
      return <span className="italic">thinking…</span>
    }
    const sec = Math.max(0, Math.floor((Date.now() - p.startedAt) / 1000))
    const elapsed = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
    const showSteps = p.iteration > 1 || p.toolsDone > 0
    const dot = <span className="text-stone-300"> · </span>

    return (
      <>
        {p.tool ? (
          <>
            🔧 <span className="font-medium text-stone-600">{p.tool}</span>…
          </>
        ) : (
          <span className="italic">thinking…</span>
        )}
        {showSteps && (
          <>
            {dot}step {p.iteration}
            {p.toolsDone > 0 && ` · ${p.toolsDone} tool call${p.toolsDone === 1 ? "" : "s"}`}
          </>
        )}
        {dot}
        <span className="tabular-nums">{elapsed}</span>
      </>
    )
  }

  return (
    <div className="flex items-center gap-2 text-stone-500 text-xs">
      <div className="flex-1 min-w-0 truncate">{body()}</div>
      <button
        onClick={stopChat}
        title="Stop the assistant"
        className="shrink-0 px-2 py-0.5 rounded border border-stone-300 text-stone-600 hover:bg-stone-100 font-medium"
      >
        ◼ Stop
      </button>
    </div>
  )
}
