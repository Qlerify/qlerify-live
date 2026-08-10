import { useStore } from "@/lib/store.ts"

export const Toast = () => {
  const toast = useStore((s) => s.toast)

  if (!toast) {
    return null
  }

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
      <div
        className={`rounded-md px-4 py-2 text-sm shadow-lg ${toast.ok ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"}`}
      >
        {toast.text}
      </div>
    </div>
  )
}
