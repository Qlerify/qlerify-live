import type { FastifyBaseLogger } from "fastify";
import { runWithTenant } from "../platform/tenancy/context.js";
import { withActorKind } from "../platform/tenancy/actor.js";
import { connectorsEnabled } from "../config/features.js";
import type { AdapterConfig } from "./types.js";
import { listSidecars, readSidecar, writeSidecar } from "./sidecar.js";
import { ingestPull, isPullInFlight } from "./ingest.js";
import { appendNote } from "./connector/journal.js";

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
  const s = cfg.schedule;
  if (!s?.enabled) return false;
  if (!Number.isFinite(s.everyMinutes) || s.everyMinutes < SCHEDULE_MIN_MINUTES) return false;
  if (!cfg.organizationId || !cfg.workflowId) return false;

  const last = s.lastAttemptAt ?? cfg.lastPullAt;
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  const waitMs = s.everyMinutes * 60_000 * backoffFactor(s.failures);
  return nowMs - lastMs >= waitMs;
}

export function nextRunAt(cfg: AdapterConfig): string | null {
  const s = cfg.schedule;
  if (!s?.enabled || !Number.isFinite(s.everyMinutes) || s.everyMinutes < SCHEDULE_MIN_MINUTES) return null;
  const last = s.lastAttemptAt ?? cfg.lastPullAt;
  const lastMs = last ? Date.parse(last) : NaN;
  if (!Number.isFinite(lastMs)) return new Date().toISOString();
  return new Date(lastMs + s.everyMinutes * 60_000 * backoffFactor(s.failures)).toISOString();
}

export type ScheduleErrorCode = "BAD_INTERVAL" | "UNKNOWN_CONNECTOR";

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(message: string, code: ScheduleErrorCode = "BAD_INTERVAL") {
    super(message);
    this.code = code;
  }
}

export function setConnectorSchedule(
  id: string,
  input: { enabled: boolean; everyMinutes?: unknown },
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
  // Turning polling OFF keeps the chosen interval, so switching back on restores it.
  const everyMinutes = submitted ?? cur.schedule?.everyMinutes ?? SCHEDULE_MIN_MINUTES;
  const schedule = { enabled: input.enabled, everyMinutes, failures: 0, lastAttemptAt: cur.schedule?.lastAttemptAt };
  writeSidecar({ ...cur, schedule });

  const wasEnabled = cur.schedule?.enabled ?? false;
  if (input.enabled !== wasEnabled) {
    appendNote(id, "note", input.enabled ? `Polling enabled — every ${everyMinutes} min.` : "Polling disabled.");
  } else if (input.enabled && everyMinutes !== cur.schedule?.everyMinutes) {
    appendNote(id, "note", `Polling interval changed to every ${everyMinutes} min.`);
  }
  return schedule;
}

function patchSchedule(id: string, patch: Partial<AdapterConfig["schedule"] & object>): void {
  const cfg = readSidecar(id);
  if (!cfg?.schedule) return;
  writeSidecar({ ...cfg, schedule: { ...cfg.schedule, ...patch } });
}

async function runOne(cfg: AdapterConfig, log?: FastifyBaseLogger): Promise<void> {
  patchSchedule(cfg.id, { lastAttemptAt: new Date().toISOString() });

  const ctx = {
    principal: { id: `service:connector-scheduler`, type: "service_account" as const },
    organizationId: cfg.organizationId!,
    workflowId: cfg.workflowId!,
  };

  try {
    // currentActorKind() answers "human" for any bound tenant context.
    await runWithTenant(ctx, () => withActorKind("system", () => ingestPull(cfg.id, { limit: null })));
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
