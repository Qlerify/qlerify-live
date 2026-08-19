import { useState } from "react"
import { useStore } from "@/lib/store.ts"
import { formatVersionDate } from "@/lib/modelData.ts"
import { formatDuration } from "@/lib/format.ts"
import {
  NOTE_BADGE,
  connDelete,
  connExport,
  connRepoint,
  connSaveBehavior,
  connSaveDateRoles,
  connTest,
  connVerify,
  connectorName,
} from "@/lib/connectorsData.ts"
import { BEHAVIORS, behaviorVerb, nothingWrittenText, performsActions, testHint, testLabel } from "@/lib/connectorBehavior.ts"
import type { AdapterBehavior, Connector } from "@/lib/types.ts"
import { StatusDot } from "./StatusDot.tsx"
import { BehaviorBadge } from "./BehaviorBadge.tsx"
import { CodeEditor } from "./CodeEditor.tsx"
import { RuleEditor } from "./RuleEditor.tsx"
import { ManifestSections } from "./ManifestSections.tsx"
import { SchedulePanel } from "./SchedulePanel.tsx"

const Chip = ({ label, value }: { label: string; value: string }) => (
  <div className="text-[11px]">
    <span className="text-stone-400">{label}</span> <span className="text-stone-700">{value}</span>
  </div>
)

const Diagnostics = ({ c }: { c: Connector }) => {
  const { connBusy, connVerify: v, connTest: t } = useStore()
  const verify = v?.id === c.id ? v : null
  const test = t?.id === c.id ? t : null
  const label = testLabel(c)
  const acts = performsActions(c)

  return (
    <div className="mt-5 rounded-lg border border-stone-200 p-4">
      <div className="text-sm font-medium text-stone-800">Connection</div>
      <div className={`text-xs mt-0.5 ${acts ? "text-amber-700" : "text-stone-500"}`}>{testHint(c)}</div>
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <button
          onClick={connVerify}
          disabled={connBusy}
          className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium"
        >
          Verify connection
        </button>
        {label && (
          <button
            onClick={connTest}
            disabled={connBusy}
            className="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium"
          >
            {label}
          </button>
        )}
        <span className="text-sm">
          {!verify ? (
            <span className="text-stone-400">not checked</span>
          ) : (
            <>
              <span className={verify.ok ? "text-emerald-700" : "text-rose-600"}>
                ● {verify.ok ? "connected" : "not connected"}
              </span>
              {verify.detail && <span className="text-stone-500"> {verify.detail}</span>}
            </>
          )}
        </span>
      </div>

      {test && test.error && <div className="mt-3 text-rose-600 text-sm">{test.error}</div>}
      {test && !test.error && (
        <div className="mt-3 space-y-2">
          <div className="text-sm">
            {test.diff?.ok ? (
              <span className="text-emerald-700 font-medium">✓ matches the model</span>
            ) : (
              <span className="text-rose-600 font-medium">✗ shape mismatch</span>
            )}{" "}
            <span className="text-stone-500">
              · {test.count} row(s) pulled, {nothingWrittenText(c)}
            </span>
          </div>
          {!!test.diff?.requiredStatus?.length && (
            <div>
              {test.diff.requiredStatus.map((r) => (
                <span
                  key={r.field}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 mr-1 mb-1 rounded text-[11px] ${r.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}
                >
                  {r.ok ? "✓" : "✗"} {r.field}
                </span>
              ))}
            </div>
          )}
          {!!test.diff?.extraFields?.length && (
            <div className="text-[11px] text-amber-700">extra unmapped fields: {test.diff.extraFields.join(", ")}</div>
          )}
        </div>
      )}
    </div>
  )
}

const BehaviorPanel = ({ c }: { c: Connector }) => {
  const connBusy = useStore((s) => s.connBusy)
  const current = c.behavior ?? "sync"
  const [picked, setPicked] = useState<AdapterBehavior>(current)

  // A pending choice must not survive selecting a different connector.
  const [seen, setSeen] = useState(c.id)
  if (seen !== c.id) {
    setSeen(c.id)
    setPicked(current)
  }

  const losingProtection = current === "actuator" && picked !== "actuator"
  const gainingProtection = current !== "actuator" && picked === "actuator"

  return (
    <div className="mt-5 rounded-lg border border-stone-200 p-4">
      <div className="text-sm font-medium text-stone-800">Type</div>
      <div className="text-xs text-stone-500 mt-0.5">
        What re-running this connector costs. It decides whether a model rebuild is allowed to run it again, and
        whether the read-only buttons above will execute its code.
      </div>
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value as AdapterBehavior)}
          disabled={connBusy}
          className="text-sm rounded-md border border-stone-300 px-2 py-1.5 bg-white disabled:opacity-40"
        >
          {BEHAVIORS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <span className="text-xs text-stone-500">{behaviorVerb(picked)}</span>
        <button
          onClick={() => connSaveBehavior(picked)}
          disabled={connBusy || picked === current}
          className="ml-auto px-4 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium"
        >
          Save type
        </button>
      </div>
      {losingProtection && (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          This connector performs actions in {c.boundedContext}. Changing it away from <b>actuator</b> removes its
          protection: a model rebuild will run it again, and the test button will execute it for real.
        </div>
      )}
      {gainingProtection && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-1">
          <div>
            Marking it <b>actuator</b> stops model rebuilds re-running it, and the test button goes away — an actuator
            has no read-only pull. Its rows stay the only record that its actions happened.
          </div>
          {c.hasCode && (
            <div>
              This changes what the platform does, not what the code does. Existing code written for a read-only
              connector won&apos;t have the actuator disciplines — checking the other system before acting, bounding
              actions by the run limit, exporting a read-only <code>probe()</code>. Without that probe, Verify can
              only report &quot;not checked&quot;. Ask the assistant to rebuild it if it should act safely.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const DetailsBody = ({ c }: { c: Connector }) => {
  const { connectors, connBusy } = useStore()
  const [target, setTarget] = useState(c.targetEntity)
  const [created, setCreated] = useState(c.dateRoles?.created || "")
  const [updated, setUpdated] = useState(c.dateRoles?.updated || "")

  // Re-point options: tables free in this workflow, plus the current target.
  const free = (connectors?.tables || []).filter((t) => !t.occupiedBy || t.occupiedBy === c.id)
  const notes = (c.notes || []).slice(-8).reverse()
  const dateFields = c.dateFields || []

  return (
    <div className="p-6 overflow-y-auto flex-1">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Chip label="System" value={c.boundedContext} />
        <Chip label="Table" value={`${c.targetEntity} (${c.targetKind})`} />
        <Chip label="Mode" value={c.mode} />
        <Chip label="Rows" value={String(c.rowCount)} />
        <Chip label="Code" value={c.hasCode ? "built" : "none"} />
        <Chip label="Credentials" value={c.credentialKeys.length ? c.credentialKeys.join(", ") : "none"} />
        <Chip label="Packages" value={c.deps.length ? c.deps.join(", ") : "none"} />
        <Chip label="Endpoint" value={c.endpoint || "—"} />
        <Chip
          label="Last pull"
          value={
            c.lastPullAt
              ? formatVersionDate(c.lastPullAt) +
                (c.lastPullDurationMs != null ? ` · ${formatDuration(c.lastPullDurationMs)}` : "")
              : "never"
          }
        />
        {!c.owned && <Chip label="Owner" value="legacy (unassigned)" />}
      </div>

      <ManifestSections connectorId={c.id} />

      <BehaviorPanel c={c} />

      <Diagnostics c={c} />

      <SchedulePanel c={c} />

      <div className="mt-5 rounded-lg border border-stone-200 p-4">
        <div className="text-sm font-medium text-stone-800">Re-point</div>
        <div className="text-xs text-stone-500 mt-0.5">
          Point this connector at a different table. Going forward only — existing rows in the old table stay put; the
          connector fills the new table on its next run.
        </div>
        <div className="flex items-center gap-2 mt-3">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="flex-1 text-sm rounded-md border border-stone-300 px-2 py-1.5 bg-white"
          >
            {free.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.kind === "valueObject" ? " (value object)" : ""}
                {t.name === c.targetEntity ? " — current" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => connRepoint(target)}
            disabled={connBusy}
            className="px-4 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium"
          >
            Re-point
          </button>
        </div>
      </div>

      {dateFields.length > 0 && (
        <div className="mt-5 rounded-lg border border-stone-200 p-4">
          <div className="text-sm font-medium text-stone-800">Event timestamps</div>
          <div className="text-xs text-stone-500 mt-0.5">
            Which source columns hold the record's creation and last-modified times. Create events are stamped with{" "}
            <b>Created</b>; update events with <b>Updated</b> — so the timeline follows the data instead of ingestion
            time. Inferred at build time; override here.
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="text-xs text-stone-600 block">
              Created
              <select
                value={created}
                onChange={(e) => setCreated(e.target.value)}
                className="mt-1 w-full text-sm rounded-md border border-stone-300 px-2 py-1.5 bg-white"
              >
                <option value="">— none —</option>
                {dateFields.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-stone-600 block">
              Updated
              <select
                value={updated}
                onChange={(e) => setUpdated(e.target.value)}
                className="mt-1 w-full text-sm rounded-md border border-stone-300 px-2 py-1.5 bg-white"
              >
                <option value="">— none —</option>
                {dateFields.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            onClick={() => connSaveDateRoles(created || null, updated || null)}
            disabled={connBusy}
            className="mt-3 px-4 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium"
          >
            Save timestamps
          </button>
          <div className="text-[11px] text-stone-400 mt-2">
            New rows pick these up on the next run. Events already in the log keep their old timestamps until you
            rebuild from data (clears &amp; re-derives the event log).
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="text-[11px] font-medium text-stone-500 uppercase tracking-wide mb-1">History</div>
        <div className="rounded-lg border border-stone-100 p-3 space-y-0.5">
          {notes.length ? (
            notes.map((n, i) => (
              <div key={i} className="flex items-baseline gap-1.5 text-[11px] py-0.5">
                <span className={`px-1 py-0.5 rounded shrink-0 ${NOTE_BADGE[n.kind] || NOTE_BADGE.note}`}>{n.kind}</span>
                <span className="flex-1 text-stone-600">{n.text}</span>
                {n.durationMs != null && (
                  <span className="text-stone-400 shrink-0 tabular-nums">{formatDuration(n.durationMs)}</span>
                )}
                <span className="text-stone-400 shrink-0">{formatVersionDate(n.at)}</span>
              </div>
            ))
          ) : (
            <div className="text-xs text-stone-400">No history recorded.</div>
          )}
        </div>
      </div>

      <div className="mt-5 rounded-lg border border-rose-200 bg-rose-50/40 p-4">
        <div className="text-sm font-medium text-rose-800">Danger zone</div>
        <div className="text-xs text-stone-600 mt-0.5">
          Completely delete this connector — its code, credentials, ingested data, derived events, and history. Cannot
          be undone.
        </div>
        <button
          onClick={connDelete}
          disabled={connBusy}
          className="mt-3 px-4 py-1.5 text-sm rounded-md border border-rose-300 bg-white text-rose-700 hover:bg-rose-100 disabled:opacity-40 font-medium"
        >
          🗑 Delete connector
        </button>
      </div>
    </div>
  )
}

export const ConnectorDetail = ({ c }: { c: Connector | null }) => {
  const { connTab, connBusy, set } = useStore()

  if (!c) {
    return <div className="p-8 text-sm text-stone-400">Select a connector to see its details.</div>
  }

  const name = connectorName(c)
  const orphan = c.status === "orphaned"
  const rules = c.triggerRules || []
  // Tab state: "details" | "code" | "rule:<eventKey>". A rule tab whose rule was
  // deleted (or another connector selected) falls back to details.
  const tab =
    connTab === "code"
      ? "code"
      : connTab.startsWith("rule:") && rules.some((r) => `rule:${r.eventKey}` === connTab)
        ? connTab
        : "details"

  const RULE_DOT: Record<string, string> = {
    ok: "bg-emerald-500",
    stale: "bg-amber-500",
    error: "bg-rose-500",
    disabled: "bg-stone-400",
    orphaned: "bg-rose-500",
  }

  const TabBtn = ({ id, label, dot }: { id: string; label: string; dot?: string }) => (
    <button
      onClick={() => set({ connTab: id })}
      className={`px-3 py-1.5 text-sm rounded-md font-medium inline-flex items-center gap-1.5 ${tab === id ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}
    >
      {dot && <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />}
      {label}
    </button>
  )

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-6 pt-6 pb-3 border-b border-stone-200">
        <div className="flex items-center gap-2">
          <StatusDot status={c.status} />
          <h2 className="text-xl font-semibold text-stone-900">{name}</h2>
          <span
            className={`px-2 py-0.5 text-[11px] rounded-full ${orphan ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}
          >
            {orphan ? "orphaned" : "active"}
          </span>
          <BehaviorBadge behavior={c.behavior} />
        </div>
        <div className="flex items-center gap-3 mt-1 text-[11px]">
          {name !== c.id && (
            <span
              className="text-stone-400"
              title="The connector's immutable id (its storage key). Re-pointing renamed it above, but the id never changes."
            >
              key <span className="font-mono text-stone-500">{c.id}</span>
            </span>
          )}
          {!orphan && (
            <a
              href={`#bcs/${encodeURIComponent(c.boundedContext)}/${encodeURIComponent(c.targetEntity)}`}
              className="text-sky-700 hover:underline"
            >
              Open table &amp; data →
            </a>
          )}
        </div>
        {c.summary ? (
          <div className="text-sm text-stone-600 mt-2 italic">{c.summary}</div>
        ) : (
          <div className="text-sm text-stone-400 mt-2 italic">No description yet — build the connector to generate one.</div>
        )}
        {orphan && (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            Its target table <b>{c.targetEntity}</b> no longer exists in the model — likely renamed or removed. It can't
            ingest until you <b>re-point</b> it at a current table (or delete it).
          </div>
        )}
        <div className="flex items-center gap-1 mt-4 flex-wrap">
          <TabBtn id="details" label="Details" />
          <TabBtn id="code" label="Code" />
          {rules.map((r) => (
            <TabBtn
              key={r.eventKey}
              id={`rule:${r.eventKey}`}
              label={r.eventName}
              dot={RULE_DOT[r.status] || RULE_DOT.ok}
            />
          ))}
          <button
            onClick={connExport}
            disabled={connBusy}
            title="Download this connector as a portable JSON backup — config, code, and credential field names (never secret values)"
            className="ml-auto px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium"
          >
            ⬇ Export
          </button>
        </div>
      </div>

      {tab === "code" ? (
        <CodeEditor connector={c} />
      ) : tab.startsWith("rule:") ? (
        <RuleEditor connector={c} eventKey={tab.slice("rule:".length)} />
      ) : (
        <DetailsBody c={c} />
      )}
    </div>
  )
}
