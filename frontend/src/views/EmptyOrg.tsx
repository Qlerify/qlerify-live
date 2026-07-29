import { useStore } from "../lib/store.ts"

export const EmptyOrg = () => {
  const set = useStore((s) => s.set)

  return (
    <main className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-md rounded-xl border border-stone-200 bg-white p-6 shadow-sm text-center">
        <div className="text-3xl mb-2">📁</div>
        <div className="text-lg font-semibold text-stone-900">No workflows yet</div>
        <div className="text-sm text-stone-500 mt-1 mb-5">
          This organization is empty. Create your first workflow — you'll point it at your own Qlerify model as part
          of creating it.
        </div>
        <button
          onClick={() => set({ newWfOpen: true, newWfErr: null })}
          className="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800"
        >
          Create your first workflow
        </button>
        <div className="text-[11px] text-stone-400 mt-3">
          You can also manage workflows from{" "}
          <a href="#admin" className="underline">
            Org Admin
          </a>
          .
        </div>
      </div>
    </main>
  )
}
