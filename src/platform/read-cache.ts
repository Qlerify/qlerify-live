// Read-through cache for the hot dashboard reads. Keys carry (org, workflow) so
// a cross-tenant hit is impossible; the write chokepoints (emit/delete/apply)
// invalidate their slice, and the TTL only backstops a write path without a hook.

import { tenantContext } from "./tenancy/context.js";

interface Entry {
  value: unknown;
  expiresAt: number;
}

// Pseudo-workflow for org-wide reads: invalidated by a write in ANY workflow.
const ORG_SCOPE = "org";

const MAX_ENTRIES = 500;
const store = new Map<string, Entry>();

function enabled(): boolean {
  const v = (process.env.QLERIFY_READ_CACHE ?? "").toLowerCase();
  if (v === "off") {
    return false;
  }
  if (v === "on") {
    return true;
  }
  return process.env.NODE_ENV !== "test";
}

function ttlMs(): number {
  const raw = Number(process.env.READ_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

const SEP = "\u0000";

function scopePrefix(orgId: string, workflowId: string): string {
  return `${orgId}${SEP}${workflowId}${SEP}`;
}

function serve<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return Promise.resolve(hit.value as T);
  }
  return compute().then((value) => {
    store.delete(key);
    store.set(key, { value, expiresAt: Date.now() + ttlMs() });
    if (store.size > MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) {
        store.delete(oldest);
      }
    }
    return value;
  });
}

/** Workflow-scoped read; bypasses when no tenant/workflow is bound. */
export async function cachedRead<T>(request: string, compute: () => Promise<T>): Promise<T> {
  const ctx = enabled() ? tenantContext() : undefined;
  if (!ctx?.organizationId || !ctx.workflowId) {
    return compute();
  }
  return serve(scopePrefix(ctx.organizationId, ctx.workflowId) + request, compute);
}

/** Org-wide read (e.g. the portfolio, which spans all the org's workflows). */
export async function cachedOrgRead<T>(request: string, compute: () => Promise<T>): Promise<T> {
  const ctx = enabled() ? tenantContext() : undefined;
  if (!ctx?.organizationId) {
    return compute();
  }
  return serve(scopePrefix(ctx.organizationId, ORG_SCOPE) + request, compute);
}

/** Drop the workflow's slice plus the org-wide slice a write could have staled. */
export function invalidateReads(orgId: string | null | undefined, workflowId?: string | null): void {
  if (!orgId) {
    return;
  }
  // With a workflow: that slice + the org-wide slice. Without: the whole org.
  const prefixes = workflowId
    ? [scopePrefix(orgId, ORG_SCOPE), scopePrefix(orgId, workflowId)]
    : [`${orgId}${SEP}`];
  for (const key of store.keys()) {
    if (prefixes.some((p) => key.startsWith(p))) {
      store.delete(key);
    }
  }
}

export function invalidateCurrentReads(): void {
  const ctx = tenantContext();
  invalidateReads(ctx?.organizationId, ctx?.workflowId);
}

export function clearReadCache(): void {
  store.clear();
}
