// The capability surface an AI-authored adapter body runs against (Part 2.3,
// Slice 2). The body — src/packs/<bc>/generated/<id>.<hash>.logic.ts — exports
// `async fetchRows(ctx)` and sees ONLY this `ctx`: a wrapped fetch (timeout +
// size cap + secret redaction + trace), the resolved secret, the model entity,
// and a limit. It is given NO ambient process.env / raw fetch / fs / prisma.
//
// SECURITY POSTURE (firewalled PoC, single-tenant): in-process execution is
// accepted. `ctx` is a CONVENTION, not a hard sandbox — the deny-scan
// (codegen/deny-scan) + lazy import (host loads the body only at run, never at
// boot) are the cheap gate. The path to real isolation is a worker/subprocess
// runner behind this same `ctx` contract (the body needs no change). See
// ARCHITECTURE.md Part 2.3 "Path to higher security".

import { envCredentialResolver, type AdapterConfig } from "./types.js";
import { assertSafeUrl } from "./net-guard.js";
import type { EntitySchema } from "../ontology/model.js";

const TIMEOUT_MS = 8000;
const MAX_BYTES = 5_000_000;

interface AdapterRunContext {
  /** The model entity the body must produce rows for (field names/types/required). */
  entity: EntitySchema;
  /** How many rows the caller wants. */
  limit: number;
  /** Configured source endpoint (from the sidecar), if any. */
  endpoint?: string;
  /** The resolved secret (from credentialsRef), if configured. Use for auth
   * headers; it is redacted from the trace and from thrown errors automatically. */
  secret?: string;
  /** fetch, wrapped: AbortController timeout, content-length cap, secret redaction
   * in errors, and an append-only trace entry per call. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Append a line to the run trace (the body must NOT use console). */
  log(message: string): void;
  /** Append-only trace shown to the operator + fed to the AI troubleshooter. */
  trace: string[];
}

export interface AdapterBody {
  fetchRows(ctx: AdapterRunContext): Promise<Array<Record<string, unknown>>>;
  probe?(ctx: AdapterRunContext): Promise<{ ok: boolean; detail?: string }>;
}

/** Build the capability ctx for one run. The secret is resolved HERE (at run),
 * never baked into the body, the prompt, the sidecar, or the trace. */
export async function createRunContext(cfg: AdapterConfig, entity: EntitySchema, limit: number): Promise<AdapterRunContext> {
  const secret = cfg.credentialsRef ? await envCredentialResolver.resolve(cfg.credentialsRef) : undefined;
  const trace: string[] = [];
  const redact = (s: string) => (secret ? s.split(secret).join("***") : s);

  const wrappedFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    trace.push(`fetch ${redact(String(url))}`);
    try {
      await assertSafeUrl(String(url)); // SSRF guard (same policy as the connector runner)
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len && len > MAX_BYTES) throw new Error(`response too large: ${len} bytes (cap ${MAX_BYTES})`);
      trace.push(`  → ${res.status} ${res.statusText}`);
      return res;
    } catch (err: any) {
      throw new Error(redact(`fetch failed: ${err?.message ?? String(err)}`));
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    entity,
    limit,
    endpoint: cfg.endpoint,
    secret,
    fetch: wrappedFetch,
    log: (message: string) => { trace.push(redact(String(message))); },
    trace,
  };
}

/** Run `fn` under a wall-clock budget; reject if it overruns. */
export async function runWithBudget<T>(fn: () => Promise<T>, budgetMs = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`adapter run exceeded ${budgetMs}ms budget`)), budgetMs);
  });
  try {
    return await Promise.race([fn(), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
