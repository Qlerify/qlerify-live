import { toggleChat } from "@/lib/chatData.ts"
import { useStore } from "@/lib/store.ts"

export const AssistantButton = () => {
  const chatOpen = useStore((s) => s.chatOpen)
  const tone = chatOpen
    ? "border-amber-400 bg-amber-50 text-amber-800"
    : "border-stone-300 bg-white hover:bg-stone-50"
  return (
    <button onClick={toggleChat} title="Assistant" className={`px-3 py-2 text-sm rounded-md border ${tone}`}>
      💬 Assistant
    </button>
  )
}
