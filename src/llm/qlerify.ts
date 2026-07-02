// The single seam for resolving Qlerify MCP credentials (endpoint URL + x-api-key)
// used to fetch a workflow model from the modeller — the network call behind the
// Model page's "⤓ Reload from link". Every fetch resolves its credentials through
// here so that a per-organization KEY (set in Organisation admin, stored encrypted
// on PlatOrganization) transparently overrides the platform-default key
// (QLERIFY_MCP_API_KEY env), falling back to that env var and, for local dev only,
// to ~/.claude.json — when the org has not configured its own. The endpoint URL is
// NOT user-settable (always the built-in default; see DEFAULT_QLERIFY_MCP_URL).
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

// The Qlerify Modeller's hosted MCP endpoint. This is effectively constant — it
// only differs for a white-labelled deployment — so it's the built-in default and
// nobody configures it. It is NOT user-settable: the only override is the operator
// env QLERIFY_MCP_URL (for white-labelling), then ~/.claude.json in local dev, then
// this default. Because the URL always resolves, the only thing anyone supplies is
// an API key.
const DEFAULT_QLERIFY_MCP_URL = "https://mcp.qlerify.com";

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
 * HARD-OFF in production — a deployed server must never read credentials from a
 * file outside its own tree (there, the only sources are the per-org encrypted
 * key and the QLERIFY_MCP_API_KEY env). Returns null when off or absent. */
function readDevCreds(): { url: string; apiKey: string } | null {
  if (process.env.NODE_ENV === "production") return null;
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

/** The platform-default MCP endpoint URL. Always resolves: an explicit env
 * override, then the local-dev fallback, then the built-in Qlerify endpoint —
 * so a missing URL is never an error a user has to fix. */
function defaultUrl(): string {
  const envUrl = process.env.QLERIFY_MCP_URL?.trim();
  if (envUrl) return envUrl;
  const dev = readDevCreds();
  if (dev) return dev.url;
  return DEFAULT_QLERIFY_MCP_URL;
}

/** The Qlerify MCP endpoint to target for a save/validate. There is no per-org
 * URL — it's always the platform default (the QLERIFY_MCP_URL operator override
 * when set, else the built-in endpoint). */
export function qlerifyEndpointUrl(): string {
  return defaultUrl();
}

/** Platform-default creds. Only a KEY is required — the endpoint URL defaults to
 * the built-in Qlerify MCP endpoint (defaultUrl). Key precedence: QLERIFY_MCP_API_KEY
 * env, then ~/.claude.json for local dev. Throws a setup-oriented error when no key
 * exists anywhere. */
function platformCreds(): QlerifyCreds {
  const hit = cache.get(PLATFORM_SLOT);
  if (hit) return hit.resolved;

  const envKey = process.env.QLERIFY_MCP_API_KEY?.trim();
  let resolved: QlerifyCreds | null = null;
  if (envKey) {
    // env key pairs with the env URL override when set, else the built-in default.
    resolved = { url: defaultUrl(), apiKey: envKey, source: "platform" };
  } else {
    const dev = readDevCreds();
    if (dev) resolved = { url: dev.url, apiKey: dev.apiKey, source: "platform" };
  }
  if (!resolved) {
    throw new DomainError(
      "No Qlerify API key is configured for this organisation. Add one in " +
        "Organisation admin → Qlerify integration to enable “Reload from link” " +
        "(no .env editing needed). (Operators can instead set a platform-wide " +
        "default with QLERIFY_MCP_API_KEY in the server environment.)",
    );
  }
  cache.set(PLATFORM_SLOT, { ciphertext: null, resolved });
  return resolved;
}

/** Resolve the Qlerify MCP creds for the current org. The org supplies only a KEY;
 * the endpoint is always the platform default (defaultUrl). Falls back to the
 * platform creds when the org has set no key. */
export async function resolveQlerifyCreds(): Promise<QlerifyCreds> {
  const orgId = currentOrgIdOrNull();
  if (!orgId) return platformCreds();

  const org = await prisma.platOrganization
    .findUnique({ where: { id: orgId }, select: { qlerifyKeyCiphertext: true } })
    .catch(() => null);
  const ciphertext = org?.qlerifyKeyCiphertext ?? null;
  if (!ciphertext) return platformCreds();

  const hit = cache.get(orgId);
  if (hit && hit.ciphertext === ciphertext) return hit.resolved;

  const resolved: QlerifyCreds = { url: defaultUrl(), apiKey: decryptSecret(ciphertext), source: "org" };
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
}

/** Non-secret status for the admin UI. Never returns the raw key. */
export async function resolveQlerifyStatus(): Promise<QlerifyStatus> {
  const orgId = currentOrgIdOrNull();
  if (orgId) {
    const org = await prisma.platOrganization
      .findUnique({
        where: { id: orgId },
        select: { qlerifyKeyCiphertext: true, qlerifyKeyHint: true },
      })
      .catch(() => null);
    if (org?.qlerifyKeyCiphertext) {
      return { configured: true, source: "org", hint: org.qlerifyKeyHint ?? null };
    }
  }
  // The endpoint URL always resolves (built-in default), so a platform default is
  // "configured" as soon as a KEY exists — env key, or the local-dev fallback.
  const platform = !!process.env.QLERIFY_MCP_API_KEY?.trim() || !!readDevCreds();
  return { configured: platform, source: platform ? "platform" : "none", hint: null };
}
