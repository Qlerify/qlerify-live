import { useEffect } from "react"
import { AUTH } from "../../lib/api.ts"
import { useStore } from "../../lib/store.ts"
import { loadModel, reloadWorkflowModel, shortWorkflowUrl } from "../../lib/modelData.ts"
import { AssistantButton } from "../../shell/AssistantButton.tsx"
import { VersionSidebar } from "./VersionSidebar.tsx"
import { ReplaceModelForm } from "./ReplaceModelForm.tsx"

export const Model = () => {
  const { me, modelStatus, modelContent, modelNoContent, modelBusy, projModelOpen, set } = useStore()

  useEffect(() => {
    loadModel().catch(() => {})
  }, [])

  const total = modelStatus ? modelStatus.total : 0
  const current = modelStatus ? modelStatus.current : -1
  const events = modelStatus?.currentVersion?.summary?.events ?? 0
  const versionLabel = total > 0 ? `v${current + 1} of ${total} · ${events} domain events` : "Not versioned yet"
  const reloadUrl = modelStatus ? modelStatus.sourceUrl : null
  const wfId = AUTH.workflow()
  const wfName = (me?.workflows || []).find((w) => w.id === wfId)?.name || "Workflow"
  const sizeKb = modelContent ? Math.round(modelContent.length / 1024) : 0

  return (
    <>
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="px-6 py-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">Qlerify model</div>
              <div className="text-stone-900 text-xl font-semibold leading-tight truncate">{wfName}</div>
              <div className="text-xs text-stone-500 mt-0.5 tabular-nums">
                {versionLabel}
                {modelContent ? ` · ${sizeKb} KB` : ""}
              </div>
            </div>
            <button
              onClick={reloadWorkflowModel}
              disabled={modelBusy || !reloadUrl}
              title={
                reloadUrl
                  ? "Re-pull the latest model from the source link, then rebuild this workflow"
                  : "No source link — this model was uploaded or pasted. Use Replace to re-point it."
              }
              className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium"
            >
              {modelBusy ? "⏳ Working…" : "⤓ Reload"}
            </button>
            <button
              onClick={() => set({ projModelOpen: !projModelOpen, projModelErr: null })}
              disabled={modelBusy}
              title="Replace this workflow's model — change the link, or upload/paste a new workflow.json"
              className="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium"
            >
              {projModelOpen ? "✕ Close replace" : "✎ Replace"}
            </button>
            <AssistantButton />
          </div>

          <div className="mt-3 flex items-center gap-2 flex-wrap text-sm">
            <span className="text-[11px] uppercase tracking-wide text-stone-500 font-semibold shrink-0">Source</span>
            {reloadUrl ? (
              <a
                href={reloadUrl}
                target="_blank"
                rel="noopener"
                title={reloadUrl}
                className="min-w-0 max-w-md text-[12px] mono text-sky-700 hover:text-sky-900 underline decoration-dotted truncate"
              >
                {shortWorkflowUrl(reloadUrl)} ↗
              </a>
            ) : (
              <span className="text-[12px] text-stone-400 italic">uploaded / pasted — no link</span>
            )}
          </div>

          <ReplaceModelForm />
        </div>
      </header>

      <main className="flex-1 flex min-h-0 overflow-hidden">
        <VersionSidebar />
        <div className="flex-1 overflow-auto bg-stone-50 flex flex-col min-w-0">
          {modelContent == null ? (
            <div className="flex-1 flex items-center justify-center p-8 text-center">
              <div>
                <div className="text-3xl mb-2">🧩</div>
                <div className="text-sm font-medium text-stone-700">
                  {modelStatus == null ? "Loading model…" : "This workflow has no model yet"}
                </div>
                {modelNoContent && (
                  <div className="text-xs text-stone-500 mt-1 max-w-sm">
                    Point it at a Qlerify model using <b>Replace</b> above.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <pre className="mono text-[12px] leading-relaxed whitespace-pre p-4 overflow-auto flex-1">
              {modelContent}
            </pre>
          )}
        </div>
      </main>
    </>
  )
}
