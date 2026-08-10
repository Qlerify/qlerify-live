import { useState } from "react"
import { connSaveSchedule } from "../../lib/connectorsData.ts"
import { formatVersionDate } from "../../lib/modelData.ts"
import { useStore } from "../../lib/store.ts"
import type { Connector } from "../../lib/types.ts"

const MIN_MINUTES = 5

const PRESETS: [number, string][] = [
  [5, "Every 5 minutes"],
  [15, "Every 15 minutes"],
  [30, "Every 30 minutes"],
  [60, "Hourly"],
  [360, "Every 6 hours"],
  [1440, "Daily"],
]

const CUSTOM = "custom"

const fmtInterval = (m: number): string => {
  if (!Number.isFinite(m) || m <= 0) {
    return "—"
  }
  if (m < 60) {
    return `${m} min`
  }
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (m % 1440 === 0) {
    return m === 1440 ? "24 h" : `${m / 1440} days`
  }
  return rem ? `${h} h ${rem} min` : `${h} h`
}

const nextRunLabel = (c: Connector): string | null => {
  const at = c.nextRunAt ? Date.parse(c.nextRunAt) : NaN
  if (!Number.isFinite(at)) {
    return null
  }
  const mins = Math.round((at - Date.now()) / 60_000)
  if (mins <= 0) {
    return "due now"
  }
  return mins < 60 ? `in ~${mins} min` : `in ~${Math.round(mins / 60)} h`
}

export const SchedulePanel = ({ c }: { c: Connector }) => {
  const connBusy = useStore((s) => s.connBusy)
  const s = c.schedule
  const saved = s?.everyMinutes ?? 60
  const [everyMinutes, setEveryMinutes] = useState(saved)
  const [custom, setCustom] = useState(() => !PRESETS.some(([m]) => m === saved))

  const on = !!s?.enabled
  const valid = Number.isFinite(everyMinutes) && everyMinutes >= MIN_MINUTES
  const unchanged = everyMinutes === s?.everyMinutes

  const pick = (v: string) => {
    if (v === CUSTOM) {
      setCustom(true)
      return
    }
    setCustom(false)
    setEveryMinutes(Number(v))
  }

  return (
    <div className="mt-5 rounded-lg border border-stone-200 p-4">
      <div className="text-sm font-medium text-stone-800">Automatic polling</div>
      <div className="text-xs text-stone-500 mt-0.5">
        Fetch from the source on a schedule, without anyone pressing a button. Each run is the same pull as{" "}
        <b>Fetch rows</b> — rows already present are skipped, and new domain events are derived automatically.
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <select
          value={custom ? CUSTOM : everyMinutes}
          onChange={(e) => pick(e.target.value)}
          disabled={connBusy}
          className="text-sm rounded-md border border-stone-300 px-2 py-1.5 bg-white disabled:opacity-40"
        >
          {PRESETS.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>

        {custom && (
          <label className="flex items-center gap-1.5 text-sm text-stone-600">
            every
            <input
              type="number"
              min={MIN_MINUTES}
              step={1}
              value={Number.isFinite(everyMinutes) ? everyMinutes : ""}
              onChange={(e) => setEveryMinutes(Math.floor(Number(e.target.value)))}
              disabled={connBusy}
              aria-label="Custom interval in minutes"
              className={`w-20 text-sm rounded-md border px-2 py-1.5 disabled:opacity-40 ${valid ? "border-stone-300" : "border-rose-300 bg-rose-50"}`}
            />
            min
            {valid && everyMinutes >= 60 && <span className="text-stone-400">({fmtInterval(everyMinutes)})</span>}
          </label>
        )}

        {on ? (
          <>
            <button
              onClick={() => connSaveSchedule(true, everyMinutes)}
              disabled={connBusy || !valid || unchanged}
              className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium"
            >
              Update interval
            </button>
            <button
              onClick={() => connSaveSchedule(false, everyMinutes)}
              disabled={connBusy}
              className="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-40 font-medium"
            >
              Turn off
            </button>
          </>
        ) : (
          <button
            onClick={() => connSaveSchedule(true, everyMinutes)}
            disabled={connBusy || !valid}
            className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-40 font-medium"
          >
            Turn on
          </button>
        )}

        <span className="text-sm">
          {on ? (
            <span className="text-emerald-700">
              ● polling every {fmtInterval(saved)}
              {nextRunLabel(c) ? <span className="text-stone-500"> · next {nextRunLabel(c)}</span> : null}
            </span>
          ) : (
            <span className="text-stone-400">not scheduled</span>
          )}
        </span>
      </div>

      {custom && !valid && (
        <div className="mt-2 text-xs text-rose-600">
          Minimum {MIN_MINUTES} minutes — each run scans the source and re-derives events, so shorter intervals cost
          more than they gain.
        </div>
      )}

      {!!s?.failures && s.failures > 0 && s.enabled && (
        <div className="mt-3 text-xs text-amber-700">
          ⚠ {s.failures} consecutive failure{s.failures === 1 ? "" : "s"} — retries are backing off. See the history
          below for the error.
        </div>
      )}

      {s?.disabledReason && (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          <b>Polling stopped automatically.</b> {s.disabledReason} — fix the connector (Test, or repair its code), then
          turn polling back on.
        </div>
      )}

      {s?.lastAttemptAt && (
        <div className="mt-2 text-[11px] text-stone-400">Last attempt {formatVersionDate(s.lastAttemptAt)}</div>
      )}
    </div>
  )
}
