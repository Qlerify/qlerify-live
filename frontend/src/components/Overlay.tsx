import { useStore } from "@/lib/store.ts"

// Blocking scrim + spinner for long server-synchronous ops (model rebuild, org
// switch). Ref-counted so nested shows don't clear early.
export const Overlay = () => {
  const overlay = useStore((s) => s.overlay)

  if (overlay.count <= 0) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="bg-white rounded-xl shadow-xl px-6 py-5 flex items-center gap-3">
        <div className="w-6 h-6 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
        <div className="text-sm text-stone-700">{overlay.label || "Working…"}</div>
      </div>
    </div>
  )
}

export const showOverlay = (label: string) => {
  const o = useStore.getState().overlay
  useStore.getState().set({ overlay: { count: o.count + 1, label: label || "Working…" } })
}

export const hideOverlay = () => {
  const o = useStore.getState().overlay
  const count = Math.max(0, o.count - 1)
  useStore.getState().set({ overlay: { count, label: count === 0 ? "" : o.label } })
}
