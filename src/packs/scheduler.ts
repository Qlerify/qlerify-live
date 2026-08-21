import type { FastifyBaseLogger } from "fastify";
import { runWithTenant } from "../platform/tenancy/context.js";
import { withActorKind } from "../platform/tenancy/actor.js";
import { connectorsEnabled } from "../config/features.js";
import type { AdapterConfig } from "./types.js";
import { listSidecars, readSidecar, writeSidecar } from "./sidecar.js";
import { ingestPull, isPullInFlight } from "./ingest.js";
import { appendNote } from "./connector/journal.js";
import { ensureWorkflowModelLoaded } from "../platform/ontology-store/ontology-store.js";

const TICK_MS = 60_000;

export const SCHEDULE_MIN_MINUTES = 5;

const MAX_FAILURES = 5;
const MAX_BACKOFF_FACTOR = 16;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

function backoffFactor(failures: unknown): number {
  const n = Number(failures);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(MAX_BACKOFF_FACTOR, 2 ** Math.floor(n));
}

export function isDue(cfg: AdapterConfig, nowMs: number): boolean {
  if (!cfg.organizationId || !cfg.workflowId) return false;
  const at = nextRunAt(cfg, nowMs);
  return at != null && nowMs >= Date.parse(at);
}

export function nextRunAt(cfg: AdapterConfig, nowMs: number = Date.now()): string | null {
  const s = cfg.schedule;
  if (!s?.enabled || !Number.isFinite(s.everyMinutes) || s.everyMinutes < SCHEDULE_MIN_MINUTES) return null;
  const intervalMs = s.everyMinutes * 60_000;
  const factor = backoffFactor(s.failures);
  const last = s.lastAttemptAt ?? cfg.lastPullAt;
  const lastMs = last ? Date.parse(last) : NaN;
  const ran = Number.isFinite(lastMs);
  const startMs = s.startAt ? Date.parse(s.startAt) : NaN;

  if (!Number.isFinite(startMs)) {
    return new Date(ran ? lastMs + intervalMs * factor : nowMs).toISOString();
  }
  if (nowMs < startMs) return new Date(startMs).toISOString();
  const slot = startMs + Math.floor((nowMs - startMs) / intervalMs) * intervalMs;
  const target = ran && lastMs >= slot ? slot + intervalMs : slot;
  // Only a FAILING connector is held past its slot; flooring on lastMs otherwise
  // would re-anchor on the late attempt and reintroduce the drift.
  if (!ran || factor <= 1) return new Date(target).toISOString();
  return new Date(Math.max(target, lastMs + intervalMs * factor)).toISOString();
}

export type ScheduleErrorCode = "BAD_INTERVAL" | "BAD_START_AT" | "UNKNOWN_CONNECTOR";

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(message: string, code: ScheduleErrorCode = "BAD_INTERVAL") {
    super(message);
    this.code = code;
  }
}

/** `""`/null clears it; an unreadable date is refused, never silently ignored.
 * Strings only — an epoch number is ambiguous between seconds and milliseconds,
 * and guessing wrong lands the schedule in 1970 without saying so. */
function parseStartAt(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && v.trim() === "")) return null;
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new ScheduleError("startAt must be a date/time string, e.g. 2026-08-21T12:00:00Z", "BAD_START_AT");
  return new Date(ms).toISOString();
}

export function setConnectorSchedule(
  id: string,
  input: { enabled: boolean; everyMinutes?: unknown; startAt?: unknown },
): NonNullable<AdapterConfig["schedule"]> {
  const cur = readSidecar(id);
  if (!cur) {
    throw new ScheduleError(`no connector "${id}"`, "UNKNOWN_CONNECTOR");
  }
  const raw = Number(input.everyMinutes);
  const submitted = Number.isFinite(raw) && raw >= SCHEDULE_MIN_MINUTES ? Math.floor(raw) : null;
  if (input.enabled && submitted == null) {
    throw new ScheduleError(`everyMinutes must be a number >= ${SCHEDULE_MIN_MINUTES}`);
  }
  const submittedStart = parseStartAt(input.startAt);
  // Turning polling OFF keeps the interval and start time, so switching back on restores them.
  const everyMinutes = submitted ?? cur.schedule?.everyMinutes ?? SCHEDULE_MIN_MINUTES;
  const startAt = submittedStart === undefined ? cur.schedule?.startAt : (submittedStart ?? undefined);
  const schedule = {
    enabled: input.enabled, everyMinutes, failures: 0,
    lastAttemptAt: cur.schedule?.lastAttemptAt,
    ...(startAt ? { startAt } : {}),
  };
  writeSidecar({ ...cur, schedule });

  const wasEnabled = cur.schedule?.enabled ?? false;
  const from = startAt ? ` First run ${startAt}.` : "";
  if (input.enabled !== wasEnabled) {
    appendNote(id, "note", input.enabled ? `Polling enabled — every ${everyMinutes} min.${from}` : "Polling disabled.");
  } else if (input.enabled && everyMinutes !== cur.schedule?.everyMinutes) {
    appendNote(id, "note", `Polling interval changed to every ${everyMinutes} min.${from}`);
  } else if (input.enabled && startAt !== cur.schedule?.startAt) {
    appendNote(id, "note", startAt ? `First run moved to ${startAt}.` : "First run time cleared; polling now follows the last run.");
  }
  return schedule;
}

function patchSchedule(id: string, patch: Partial<AdapterConfig["schedule"] & object>): void {
  const cfg = readSidecar(id);
  if (!cfg?.schedule) return;
  writeSidecar({ ...cfg, schedule: { ...cfg.schedule, ...patch } });
}

export async function runOne(cfg: AdapterConfig, log?: FastifyBaseLogger): Promise<void> {
  patchSchedule(cfg.id, { lastAttemptAt: new Date().toISOString() });

  const ctx = {
    principal: { id: `service:connector-scheduler`, type: "service_account" as const },
    organizationId: cfg.organizationId!,
    workflowId: cfg.workflowId!,
  };

  try {
    // currentActorKind() answers "human" for any bound tenant context.
    await runWithTenant(ctx, () =>
      withActorKind("system", async () => {
        await ensureWorkflowModelLoaded(ctx.organizationId, ctx.workflowId);
        return ingestPull(cfg.id, { limit: null });
      }),
    );
    patchSchedule(cfg.id, { failures: 0, disabledReason: undefined });
    log?.info({ connector: cfg.id }, "scheduled connector pull completed");
  } catch (err: any) {
    const failures = (readSidecar(cfg.id)?.schedule?.failures ?? 0) + 1;
    const msg = String(err?.message ?? err).slice(0, 300);
    const giveUp = failures >= MAX_FAILURES;
    patchSchedule(cfg.id, {
      failures,
      ...(giveUp ? { enabled: false, disabledReason: `auto-disabled after ${failures} consecutive failures: ${msg}` } : {}),
    });
    try {
      appendNote(
        cfg.id,
        "failed",
        giveUp
          ? `Scheduled pull failed ${failures}× in a row — polling auto-disabled. Last error: ${msg}`
          : `Scheduled pull failed (${failures}/${MAX_FAILURES}): ${msg}`,
      );
    } catch { /* journaling must never mask the run */ }
    log?.warn({ connector: cfg.id, failures, err }, "scheduled connector pull failed");
  }
}

export async function runDueConnectors(nowMs = Date.now(), log?: FastifyBaseLogger): Promise<string[]> {
  if (!connectorsEnabled()) return [];
  const due = listSidecars().filter((c) => isDue(c, nowMs) && !isPullInFlight(c.id));
  const ran: string[] = [];
  for (const cfg of due) {
    await runOne(cfg, log);
    ran.push(cfg.id);
  }
  return ran;
}

export function startConnectorScheduler(log?: FastifyBaseLogger): void {
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    runDueConnectors(Date.now(), log)
      .catch((err) => log?.warn({ err }, "connector scheduler tick failed"))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  timer.unref?.();
  log?.info({ tickMs: TICK_MS, minMinutes: SCHEDULE_MIN_MINUTES }, "connector scheduler started");
}

export function stopConnectorScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
}
