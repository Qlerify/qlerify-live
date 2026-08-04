// Placeholder for views not yet ported — removed as each lands in Phase 2.
export const NotPorted = ({ view }: { view: string }) => (
  <main className="flex-1 flex items-center justify-center p-10">
    <div className="text-center max-w-md">
      <div className="text-3xl mb-2">🚧</div>
      <div className="text-lg font-semibold text-stone-800">“{view}” not ported yet</div>
      <div className="text-sm text-stone-500 mt-1">
        The shell, routing, and auth are live. This view arrives in Phase 2 — use the legacy UI for it meanwhile.
      </div>
    </div>
  </main>
)
