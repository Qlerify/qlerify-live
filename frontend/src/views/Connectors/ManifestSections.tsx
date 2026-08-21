import { useEffect, useState } from "react"
import { fetchConnectorManifest } from "@/lib/connectorsData.ts"
import { useStore } from "@/lib/store.ts"
import type { ConnectorManifest, ManifestSection } from "@/lib/types.ts"

type ManifestState =
  | { phase: "loading" }
  | { phase: "ready"; manifest: ConnectorManifest }
  | { phase: "error"; message: string }

// Colour per trigger-rule status (also used for the rule tab dots).
export const RULE_STATUS_TONE: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-700",
  stale: "bg-amber-100 text-amber-800",
  error: "bg-rose-100 text-rose-700",
  disabled: "bg-stone-200 text-stone-600",
  orphaned: "bg-rose-100 text-rose-700",
  static: "bg-stone-100 text-stone-500",
}

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <div className="mt-4 rounded-lg border border-stone-200 p-4">
    <div className="text-sm font-medium text-stone-800">{title}</div>
    {hint && <div className="text-xs text-stone-500 mt-0.5">{hint}</div>}
    <div className="mt-2">{children}</div>
  </div>
)

const Bar = ({ w }: { w: string }) => (
  <div className={`h-3 rounded bg-stone-200/70 animate-pulse motion-reduce:animate-none ${w}`} />
)

// Matches the real sections' chrome so nothing jumps when the manifest lands.
const ManifestSkeleton = () => (
  <div role="status" aria-busy="true">
    <span className="sr-only">Loading what this connector does…</span>
    {[
      ["w-28", ["w-3/5", "w-2/5"]],
      ["w-44", ["w-11/12", "w-4/5", "w-9/12"]],
      ["w-36", ["w-1/2"]],
    ].map(([title, lines], i) => (
      <div key={i} className="mt-4 rounded-lg border border-stone-200 p-4" aria-hidden="true">
        <div className={`h-4 rounded bg-stone-200 animate-pulse motion-reduce:animate-none ${title as string}`} />
        <div className="mt-3 flex flex-col gap-2">
          {(lines as string[]).map((w) => (
            <Bar key={w} w={w} />
          ))}
        </div>
      </div>
    ))}
  </div>
)

// The manifest's dynamic sections: only what applies to THIS connector appears.
// Schedule + timestamps stay out — they have dedicated interactive panels on the
// Details tab; rendering them twice would just drift.
export const ManifestSections = ({ connectorId }: { connectorId: string }) => {
  const set = useStore((s) => s.set)
  const [state, setState] = useState<ManifestState>({ phase: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setState({ phase: "loading" })
    fetchConnectorManifest(connectorId)
      .then((manifest) => live && setState({ phase: "ready", manifest }))
      .catch((e: Error) => live && setState({ phase: "error", message: e?.message || "the request failed" }))
    return () => {
      live = false
    }
  }, [connectorId, attempt])

  if (state.phase === "loading") {
    return <ManifestSkeleton />
  }
  if (state.phase === "error") {
    return (
      <Section title="What this connector does" hint="This describes the built code. The connector itself is unaffected.">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="text-rose-600">Could not load it — {state.message}.</span>
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="px-2.5 py-1 rounded-md border border-stone-300 bg-white hover:bg-stone-50 font-medium"
          >
            Try again
          </button>
        </div>
      </Section>
    )
  }
  const { manifest } = state
  const section = <K extends ManifestSection["kind"]>(kind: K) =>
    manifest.sections.find((s): s is Extract<ManifestSection, { kind: K }> => s.kind === kind)

  const creds = section("credentials")
  const endpoint = section("endpoint")
  const packages = section("packages")
  const filters = section("filters")
  const incremental = section("incremental")
  const events = section("canTriggerEvents")

  return (
    <>
      {(creds || endpoint || packages) && (
        <Section title="Source access">
          <div className="space-y-1 text-xs text-stone-600">
            {creds && (
              <div>
                <span className="text-stone-400">Credentials</span> {creds.keys.join(", ")}
              </div>
            )}
            {endpoint && (
              <div>
                <span className="text-stone-400">Endpoint</span> <span className="font-mono">{endpoint.endpoint}</span>
              </div>
            )}
            {packages && (
              <div>
                <span className="text-stone-400">Packages</span> {packages.deps.join(", ")}
              </div>
            )}
          </div>
        </Section>
      )}

      {(filters || incremental) && (
        <Section title="Filters & re-run behavior" hint="What the built code actually does — extracted from the source on every build/save.">
          {filters && (
            <ul className="text-xs text-stone-600 list-disc ml-4 space-y-0.5">
              {filters.items.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          {incremental && <div className="text-xs text-stone-600 mt-1">↻ {incremental.behavior}</div>}
        </Section>
      )}

      {events && (
        <Section
          title="Can trigger events"
          hint="Every domain event this table drives. Ruled events fire on their compiled condition; the rest use the platform's generic evidence heuristics."
        >
          <div className="space-y-1">
            {events.items.map((e) => (
              <div key={e.eventKey} className="flex items-baseline gap-2 text-xs py-0.5">
                <span
                  className={`px-1.5 py-0.5 rounded shrink-0 text-[10px] ${RULE_STATUS_TONE[e.status] || RULE_STATUS_TONE.static}`}
                  title={e.statusDetail || undefined}
                >
                  {e.status}
                </span>
                {e.condition != null ? (
                  <button
                    onClick={() => set({ connTab: `rule:${e.eventKey}` })}
                    className="text-sky-700 hover:underline shrink-0 font-medium"
                    title="Open this rule's code tab"
                  >
                    {e.eventName}
                  </button>
                ) : (
                  <span className="text-stone-700 shrink-0 font-medium">{e.eventName}</span>
                )}
                <span className="text-stone-500 truncate">
                  {e.condition ?? (e.coupledTo ? `completes with ${e.coupledTo}` : "generic heuristic")}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}
