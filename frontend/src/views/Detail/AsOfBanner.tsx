import { useStore } from "@/lib/store.ts"

export const AsOfBanner = () => {
  const { events, selectedStep, set } = useStore()

  if (selectedStep == null) {
    return null
  }
  const e = events[selectedStep]
  if (!e) {
    return null
  }

  return (
    <div className="px-6 py-2 bg-sky-50 border-b border-sky-200 flex items-center gap-3 text-sm">
      <span className="inline-block w-2 h-2 rounded-full bg-sky-500" />
      <span className="text-sky-900">
        Showing data <span className="font-semibold">as of</span> step {selectedStep + 1} ·{" "}
        <span className="font-semibold">{e.name}</span>{" "}
        <span className="text-sky-700">— fields it changed are highlighted</span>
      </span>
      <button
        onClick={() => set({ selectedStep: null })}
        className="ml-auto px-2.5 py-1 text-xs rounded-md border border-sky-300 bg-white hover:bg-sky-100 text-sky-800 font-medium"
      >
        Show latest →
      </button>
    </div>
  )
}
