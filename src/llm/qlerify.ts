// The single seam for resolving Qlerify MCP credentials (endpoint URL + x-api-key)
// used to fetch a workflow model from the modeller — the network call behind the
// Model page's "⤓ Reload from link". Every fetch resolves its credentials through
// here so that a per-organization key (set in Organisation admin, stored encrypted
// on PlatOrganization) transparently overrides the platform default
// (QLERIFY_MCP_URL + QLERIFY_MCP_API_KEY env), falling back to those env vars and,
// for local dev only, to ~/.claude.json — when the org has not configured its own.
//
// The org is read from the request-bound tenant context (AsyncLocalStorage), so
// callers never thread an org id through their signatures. Off-request callers
// (the codegen CLIs, boot, tests) have no context → they get the platform creds.
// This mirrors src/llm/anthropic.ts; the two are deliberately parallel.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { prisma } from "../db.js";
import { DomainError } from "../errors.js";
import { tenantContext } from "../platform/tenancy/context.js";
import { decryptSecret } from "../platform/secrets/secret-box.js";

type QlerifySource = "org" | "platform";

export interface QlerifyCreds {
  url: string;
  apiKey: string;
  source: QlerifySource;
}

// Creds cache. Org entries are keyed by org id and carry the ciphertext they were
// built from, so a key rotation auto-busts the cache; the platform creds live under
// a fixed slot. URL-only changes are covered by the explicit invalidate-on-save.
interface CacheEntry {
  ciphertext: string | null;
  resolved: QlerifyCreds;
}
const PLATFORM_SLOT = "__platform__";
const cache = new Map<string, CacheEntry>();

/** The org id bound to the current request, or null off-request / identity-only.
 * Uses tenantContext() (not currentOrgId()) so it never throws — a missing or
 * org-less context simply means "use the platform default creds". */
function currentOrgIdOrNull(): string | null {
  return tenantContext()?.organizationId ?? null;
}

/** Dev-only fallback: read MCP creds from ~/.claude.json (mcpServers.qlerify).
 * Returns null when the file or entry is absent — env is preferred in prod. */
function readDevCreds(): { url: string; apiKey: string } | null {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const q = cfg?.mcpServers?.qlerify;
    const url = q?.url;
    const apiKey = q?.headers?.["x-api-key"];
    if (!url || !apiKey) return null;
    return { url, apiKey };
  } catch {
    return null;
  }
}

/** The platform-default MCP endpoint URL: env first, then the dev fallback. */
function defaultUrl(): string {
  const envUrl = process.env.QLERIFY_MCP_URL;
  if (envUrl) return envUrl;
  const dev = readDevCreds();
  if (dev) return dev.url;
  throw new DomainError(
    "No Qlerify MCP URL configured — set QLERIFY_MCP_URL in .env, or set your " +
      "organization's MCP URL in Organisation admin.",
  );
}

/** The effective MCP URL for a save/validate: the org's override when provided,
 * else the platform default (env, then dev fallback). */
export function qlerifyMcpUrlFor(orgUrlOverride?: string | null): string {
  const o = (orgUrlOverride ?? "").trim();
  return o || defaultUrl();
}

/** Platform-default creds: env (QLERIFY_MCP_URL + QLERIFY_MCP_API_KEY) first, then
 * ~/.claude.json for local dev. Throws a setup-oriented error when neither exists. */
function platformCreds(): QlerifyCreds {
  const hit = cache.get(PLATFORM_SLOT);
  if (hit) return hit.resolved;

  const envUrl = process.env.QLERIFY_MCP_URL;
  const envKey = process.env.QLERIFY_MCP_API_KEY;
  let resolved: QlerifyCreds | null = null;
  if (envUrl && envKey) {
    resolved = { url: envUrl, apiKey: envKey, source: "platform" };
  } else {
    const dev = readDevCreds();
    if (dev) resolved = { url: dev.url, apiKey: dev.apiKey, source: "platform" };
  }
  if (!resolved) {
    throw new DomainError(
      "No Qlerify credentials available — set QLERIFY_MCP_URL + QLERIFY_MCP_API_KEY " +
        "in .env (the platform default), or configure your organization's own key in " +
        "Organisation admin.",
    );
  }
  cache.set(PLATFORM_SLOT, { ciphertext: null, resolved });
  return resolved;
}

/** Resolve the Qlerify MCP creds for the current org. Org key when set, else the
 * platform default. The org may supply only a key (reusing the platform URL) or
 * both a key and its own MCP URL. */
export async function resolveQlerifyCreds(): Promise<QlerifyCreds> {
  const orgId = currentOrgIdOrNull();
  if (!orgId) return platformCreds();

  const org = await prisma.platOrganization
    .findUnique({ where: { id: orgId }, select: { qlerifyKeyCiphertext: true, qlerifyMcpUrl: true } })
    .catch(() => null);
  const ciphertext = org?.qlerifyKeyCiphertext ?? null;
  if (!ciphertext) return platformCreds();

  const hit = cache.get(orgId);
  if (hit && hit.ciphertext === ciphertext) return hit.resolved;

  const url = (org?.qlerifyMcpUrl && org.qlerifyMcpUrl.trim()) || defaultUrl();
  const resolved: QlerifyCreds = { url, apiKey: decryptSecret(ciphertext), source: "org" };
  cache.set(orgId, { ciphertext, resolved });
  return resolved;
}

/** Drop the cached creds for an org so a freshly saved/cleared key takes effect
 * immediately. Called by the write path after a successful save. */
export function invalidateQlerifyCache(orgId: string): void {
  cache.delete(orgId);
}

export interface QlerifyStatus {
  configured: boolean; // is any creds available at all (org or platform)?
  source: QlerifySource | "none";
  hint: string | null; // masked org-key preview when source === "org"
  mcpUrl: string | null; // the org's MCP URL override when source === "org"
}

/** Non-secret status for the admin UI. Never returns the raw key. */
export async function resolveQlerifyStatus(): Promise<QlerifyStatus> {
  const orgId = currentOrgIdOrNull();
  if (orgId) {
    const org = await prisma.platOrganization
      .findUnique({
        where: { id: orgId },
        select: { qlerifyKeyCiphertext: true, qlerifyKeyHint: true, qlerifyMcpUrl: true },
      })
      .catch(() => null);
    if (org?.qlerifyKeyCiphertext) {
      return { configured: true, source: "org", hint: org.qlerifyKeyHint ?? null, mcpUrl: org.qlerifyMcpUrl ?? null };
    }
  }
  const platform = !!(process.env.QLERIFY_MCP_URL && process.env.QLERIFY_MCP_API_KEY) || !!readDevCreds();
  return { configured: platform, source: platform ? "platform" : "none", hint: null, mcpUrl: null };
}
