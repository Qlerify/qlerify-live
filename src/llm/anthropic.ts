// The single seam for building an Anthropic client. Every AI feature resolves
// its client through here so that a per-organization key (set in Organisation
// admin, stored encrypted on PlatOrganization) transparently overrides the
// platform default ANTHROPIC_API_KEY — falling back to that env key when the
// org has not configured its own.
//
// The org is read from the request-bound tenant context (AsyncLocalStorage), so
// callers never thread an org id through their signatures. Off-request callers
// (the two codegen CLIs, boot, tests) have no context → they get the platform
// env client. All Anthropic SDK construction lives here; nothing else should
// `new Anthropic()` directly.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db.js";
import { DomainError } from "../errors.js";
import { tenantContext } from "../platform/tenancy/context.js";
import { decryptSecret } from "../platform/secrets/secret-box.js";

export const DEFAULT_MODEL = process.env.CHAT_MODEL ?? "claude-sonnet-4-6";

export type AnthropicSource = "org" | "platform";

export interface ResolvedAnthropic {
  client: Anthropic;
  model: string;
  source: AnthropicSource;
}

// Client cache. Org entries are keyed by org id and carry the ciphertext they
// were built from, so a key rotation auto-busts the cache even without explicit
// invalidation; the platform (env-key) client lives under a fixed slot.
interface CacheEntry {
  ciphertext: string | null;
  resolved: ResolvedAnthropic;
}
const PLATFORM_SLOT = "__platform__";
const cache = new Map<string, CacheEntry>();

/** The org id bound to the current request, or null off-request / identity-only.
 * Uses tenantContext() (not currentOrgId()) so it never throws — a missing or
 * org-less context simply means "use the platform default key". */
function currentOrgIdOrNull(): string | null {
  return tenantContext()?.organizationId ?? null;
}

function platformClient(): ResolvedAnthropic {
  const hit = cache.get(PLATFORM_SLOT);
  if (hit) return hit.resolved;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new DomainError(
      "No Anthropic key available — set ANTHROPIC_API_KEY in .env (the platform " +
        "default), or configure your organization's own key in Organisation admin.",
    );
  }
  const resolved: ResolvedAnthropic = { client: new Anthropic(), model: DEFAULT_MODEL, source: "platform" };
  cache.set(PLATFORM_SLOT, { ciphertext: null, resolved });
  return resolved;
}

/** Resolve the Anthropic client + model for the current org. Org key when set,
 * else the platform default. */
export async function getAnthropicClient(): Promise<ResolvedAnthropic> {
  const orgId = currentOrgIdOrNull();
  if (!orgId) return platformClient();

  const org = await prisma.platOrganization
    .findUnique({ where: { id: orgId }, select: { anthropicKeyCiphertext: true, anthropicModel: true } })
    .catch(() => null);
  const ciphertext = org?.anthropicKeyCiphertext ?? null;
  if (!ciphertext) return platformClient();

  const hit = cache.get(orgId);
  if (hit && hit.ciphertext === ciphertext) return hit.resolved;

  const resolved: ResolvedAnthropic = {
    client: new Anthropic({ apiKey: decryptSecret(ciphertext) }),
    model: org?.anthropicModel ?? DEFAULT_MODEL,
    source: "org",
  };
  cache.set(orgId, { ciphertext, resolved });
  return resolved;
}

/** Drop the cached client for an org so a freshly saved/cleared key takes effect
 * immediately. Called by the write path after a successful save. */
export function invalidateAnthropicCache(orgId: string): void {
  cache.delete(orgId);
}

export interface AnthropicStatus {
  configured: boolean; // is any key available at all (org or platform)?
  source: AnthropicSource | "none";
  hint: string | null; // masked org-key preview when source === "org"
  model: string;
}

/** Non-secret status for the admin UI + /chat/info. Never returns the raw key. */
export async function resolveAnthropicStatus(): Promise<AnthropicStatus> {
  const orgId = currentOrgIdOrNull();
  if (orgId) {
    const org = await prisma.platOrganization
      .findUnique({
        where: { id: orgId },
        select: { anthropicKeyCiphertext: true, anthropicKeyHint: true, anthropicModel: true },
      })
      .catch(() => null);
    if (org?.anthropicKeyCiphertext) {
      return { configured: true, source: "org", hint: org.anthropicKeyHint ?? null, model: org.anthropicModel ?? DEFAULT_MODEL };
    }
  }
  const platform = !!process.env.ANTHROPIC_API_KEY;
  return { configured: platform, source: platform ? "platform" : "none", hint: null, model: DEFAULT_MODEL };
}

/** Validate-on-save: build a throwaway client with the supplied key and make a
 * minimal call. Throws DomainError (422, surfaced to the admin UI) on any
 * failure so a bad key is rejected before it is ever persisted. */
export async function validateAnthropicKey(apiKey: string, model?: string): Promise<void> {
  try {
    await new Anthropic({ apiKey }).messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DomainError(`Anthropic key validation failed: ${msg}`);
  }
}
