// The single seam for building an LLM client. Every AI feature resolves its
// client through here. Two independent axes decide what a caller gets:
//
//   PROVIDER — "anthropic" (first-party API) or "bedrock" (Claude through an
//   AWS account). Both SDK clients expose the identical `.messages.create`
//   surface, so downstream callers never branch.
//
//   WHO DECIDES — the deployment operator or the organization:
//     1. LOCKED (LLM_SETTINGS_LOCKED=true): the .env provider config is the only
//        config. Per-org settings are ignored on the read path AND rejected on
//        the write path (see setOrgAnthropicConfig); the UI renders read-only.
//        A locked deployment MUST have a working platform provider — enforced
//        at boot by assertLlmBootConfig().
//     2. OPEN with fallback: orgs pick their own provider in Org Admin
//        (first-party key, or Bedrock region+model+their own AWS credentials);
//        unconfigured orgs fall back to the .env platform default.
//     3. OPEN without fallback: same, but no .env default exists — an org that
//        has not configured a provider has AI features disabled.
//
// The org is read from the request-bound tenant context (AsyncLocalStorage), so
// callers never thread an org id through their signatures. Off-request callers
// (the two codegen CLIs, boot, tests) have no context → they get the platform
// client. All LLM SDK construction lives here; nothing else should
// `new Anthropic()` / `new AnthropicBedrock()` directly.

import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { prisma } from "../db.js";
import { DomainError, LlmError } from "../errors.js";
import { tenantContext } from "../platform/tenancy/context.js";
import { decryptSecret, maskSecret } from "../platform/secrets/secret-box.js";

const DEFAULT_MODEL = process.env.CHAT_MODEL ?? "claude-sonnet-4-6";

export type LlmProvider = "anthropic" | "bedrock";
type AnthropicSource = "org" | "platform";

export interface ResolvedAnthropic {
  client: Anthropic;
  model: string;
  source: AnthropicSource;
  provider: LlmProvider;
}

/** True when the deployment centrally manages the LLM config: per-org settings
 * are ignored (reads) and rejected (writes). Read live so tests can flip it. */
export function llmSettingsLocked(): boolean {
  const v = (process.env.LLM_SETTINGS_LOCKED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** The platform-default provider, chosen at deploy time via LLM_PROVIDER.
 * "bedrock" routes the platform client to AWS Bedrock; anything else (including
 * unset) keeps the first-party Anthropic API. */
function platformProvider(): LlmProvider {
  return (process.env.LLM_PROVIDER ?? "").trim().toLowerCase() === "bedrock" ? "bedrock" : "anthropic";
}

/** Read + validate the platform Bedrock deploy config. Region and model are both
 * required and account/region-specific, so there is no safe default to guess —
 * a missing value throws a setup-oriented error rather than silently 404ing at
 * call time. The model is a Bedrock model or inference-profile id, NOT a bare
 * first-party alias. */
function bedrockEnvConfig(): { region: string; model: string } {
  const region = (process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "").trim();
  if (!region) {
    throw new DomainError(
      "LLM_PROVIDER=bedrock but no AWS region is set — set BEDROCK_REGION (or AWS_REGION) " +
        "to the region where Claude is enabled in the AWS account.",
    );
  }
  const model = (process.env.BEDROCK_MODEL ?? "").trim();
  if (!model) {
    throw new DomainError(
      "LLM_PROVIDER=bedrock but BEDROCK_MODEL is not set — set it to the Bedrock model or " +
        'inference-profile id for Claude (e.g. "anthropic.claude-sonnet-4-5-20250929-v1:0" ' +
        'or a "us.anthropic.claude-…" cross-region inference profile).',
    );
  }
  return { region, model };
}

/** Fail-safe for the locked state, called once at boot: locking the per-org UI
 * while the platform provider is unconfigured would disable AI for every org
 * with no way to override — refuse to start instead of failing silently. */
export function assertLlmBootConfig(): void {
  if (!llmSettingsLocked()) return;
  if (platformProvider() === "bedrock") {
    bedrockEnvConfig(); // throws with a setup-oriented message when incomplete
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new DomainError(
      "LLM_SETTINGS_LOCKED=true but no platform provider is configured — a locked deployment " +
        "must set ANTHROPIC_API_KEY (or LLM_PROVIDER=bedrock + BEDROCK_REGION + BEDROCK_MODEL) " +
        "in .env. Locking without a working provider would disable AI for every organization.",
    );
  }
}

// Client cache. Org entries are keyed by org id; the platform (env) client lives
// under a fixed slot. Every entry carries a fingerprint of the config it was
// built from, so a key rotation, provider switch, or env change auto-busts the
// cache even without explicit invalidation.
interface CacheEntry {
  fingerprint: string;
  resolved: ResolvedAnthropic;
}
const PLATFORM_SLOT = "__platform__";
const cache = new Map<string, CacheEntry>();

function platformFingerprint(): string {
  return [
    platformProvider(),
    process.env.ANTHROPIC_API_KEY ?? "",
    process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "",
    process.env.BEDROCK_MODEL ?? "",
  ].join("|");
}

/** The org id bound to the current request, or null off-request / identity-only.
 * Uses tenantContext() (not currentOrgId()) so it never throws — a missing or
 * org-less context simply means "use the platform default". */
function currentOrgIdOrNull(): string | null {
  return tenantContext()?.organizationId ?? null;
}

function platformClient(): ResolvedAnthropic {
  const fp = platformFingerprint();
  const hit = cache.get(PLATFORM_SLOT);
  if (hit && hit.fingerprint === fp) return hit.resolved;
  const resolved =
    platformProvider() === "bedrock" ? buildPlatformBedrockClient() : buildPlatformAnthropicClient();
  cache.set(PLATFORM_SLOT, { fingerprint: fp, resolved });
  return resolved;
}

function buildPlatformAnthropicClient(): ResolvedAnthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new DomainError(
      "No Anthropic key available — set ANTHROPIC_API_KEY in .env (the platform " +
        "default), or configure your organization's own AI provider in Organisation admin.",
    );
  }
  return { client: new Anthropic(), model: DEFAULT_MODEL, source: "platform", provider: "anthropic" };
}

function buildPlatformBedrockClient(): ResolvedAnthropic {
  const { region, model } = bedrockEnvConfig();
  // Credentials come from the standard AWS chain (IAM role / env / shared profile);
  // no key material is passed here or persisted anywhere. `as unknown as Anthropic`:
  // AnthropicBedrock is a sibling BaseAnthropic subclass exposing the identical
  // `.messages.create` surface every caller uses — the cast keeps this seam typed as
  // Anthropic without threading a client union through the five call sites.
  const client = new AnthropicBedrock({ awsRegion: region }) as unknown as Anthropic;
  return { client, model, source: "platform", provider: "bedrock" };
}

// The per-org LLM columns this seam reads. anthropicKeyHint is status-only.
const ORG_LLM_SELECT = {
  llmProvider: true,
  anthropicKeyCiphertext: true,
  anthropicKeyHint: true,
  anthropicModel: true,
  bedrockRegion: true,
  bedrockModel: true,
  bedrockAccessKeyId: true,
  bedrockSecretCiphertext: true,
} as const;

interface OrgLlmRow {
  llmProvider: string | null;
  anthropicKeyCiphertext: string | null;
  anthropicKeyHint: string | null;
  anthropicModel: string | null;
  bedrockRegion: string | null;
  bedrockModel: string | null;
  bedrockAccessKeyId: string | null;
  bedrockSecretCiphertext: string | null;
}

/** Which provider the org's stored config effectively selects, or null when the
 * org has nothing usable (→ platform fallback). A legacy org that saved a key
 * before the provider column existed (llmProvider null, key set) counts as
 * "anthropic". A half-written Bedrock config never resolves — the write path
 * validates completeness, so anything partial is treated as unconfigured. */
function effectiveOrgProvider(org: OrgLlmRow): LlmProvider | null {
  if (org.llmProvider === "bedrock") {
    const complete =
      !!org.bedrockRegion && !!org.bedrockModel && !!org.bedrockAccessKeyId && !!org.bedrockSecretCiphertext;
    return complete ? "bedrock" : null;
  }
  if ((org.llmProvider === "anthropic" || org.llmProvider == null) && org.anthropicKeyCiphertext) {
    return "anthropic";
  }
  return null;
}

function orgFingerprint(org: OrgLlmRow): string {
  return [
    org.llmProvider ?? "",
    org.anthropicKeyCiphertext ?? "",
    org.anthropicModel ?? "",
    org.bedrockRegion ?? "",
    org.bedrockModel ?? "",
    org.bedrockAccessKeyId ?? "",
    org.bedrockSecretCiphertext ?? "",
  ].join("|");
}

function buildOrgAnthropicClient(org: OrgLlmRow): ResolvedAnthropic {
  return {
    client: new Anthropic({ apiKey: decryptSecret(org.anthropicKeyCiphertext!) }),
    model: org.anthropicModel ?? DEFAULT_MODEL,
    source: "org",
    provider: "anthropic",
  };
}

function buildOrgBedrockClient(org: OrgLlmRow): ResolvedAnthropic {
  // The org's OWN AWS credentials (Way B: explicit, revocable, billed to the
  // org's account) — decrypted here, passed to the SDK, never logged. Same
  // sibling-subclass cast as the platform Bedrock client above.
  const client = new AnthropicBedrock({
    awsRegion: org.bedrockRegion!,
    awsAccessKey: org.bedrockAccessKeyId!,
    awsSecretKey: decryptSecret(org.bedrockSecretCiphertext!),
  }) as unknown as Anthropic;
  return { client, model: org.bedrockModel!, source: "org", provider: "bedrock" };
}

/** Resolve the LLM client + model for the current org. Locked deployments always
 * get the platform client (per-org config is ignored); otherwise the org's own
 * provider when configured, else the platform default. */
export async function getAnthropicClient(): Promise<ResolvedAnthropic> {
  const orgId = currentOrgIdOrNull();
  if (!orgId || llmSettingsLocked()) return platformClient();

  const org = await prisma.platOrganization
    .findUnique({ where: { id: orgId }, select: ORG_LLM_SELECT })
    .catch(() => null);
  if (!org) return platformClient();

  const provider = effectiveOrgProvider(org);
  if (!provider) return platformClient();

  const fp = orgFingerprint(org);
  const hit = cache.get(orgId);
  if (hit && hit.fingerprint === fp) return hit.resolved;

  const resolved = provider === "bedrock" ? buildOrgBedrockClient(org) : buildOrgAnthropicClient(org);
  cache.set(orgId, { fingerprint: fp, resolved });
  return resolved;
}

/** Drop the cached client for an org so a freshly saved/cleared config takes
 * effect immediately. Called by the write path after a successful save. (The
 * fingerprint check would catch it on the next resolve anyway; this just makes
 * it synchronous.) */
export function invalidateAnthropicCache(orgId: string): void {
  cache.delete(orgId);
}

export interface AnthropicStatus {
  configured: boolean; // is any provider usable at all (org or platform)?
  locked: boolean; // is the deployment centrally managed (LLM_SETTINGS_LOCKED)?
  provider: LlmProvider | "none"; // which provider is active
  source: AnthropicSource | "none"; // whose config it comes from
  hint: string | null; // masked credential preview (org config only — env secrets are never surfaced)
  model: string;
  region: string | null; // bedrock only
}

function platformStatus(): AnthropicStatus {
  const locked = llmSettingsLocked();
  if (platformProvider() === "bedrock") {
    const region = (process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "").trim();
    const model = (process.env.BEDROCK_MODEL ?? "").trim();
    const configured = !!region && !!model;
    return {
      configured,
      locked,
      provider: configured ? "bedrock" : "none",
      source: configured ? "platform" : "none",
      hint: null,
      model: model || DEFAULT_MODEL,
      region: region || null,
    };
  }
  const configured = !!process.env.ANTHROPIC_API_KEY;
  return {
    configured,
    locked,
    provider: configured ? "anthropic" : "none",
    source: configured ? "platform" : "none",
    hint: null,
    model: DEFAULT_MODEL,
    region: null,
  };
}

/** Non-secret status for the admin UI + /chat/info. Never returns raw key
 * material — org credentials surface only as masked hints, and the platform
 * env config surfaces provider/model/region only. */
export async function resolveAnthropicStatus(orgId: string | null = currentOrgIdOrNull()): Promise<AnthropicStatus> {
  if (llmSettingsLocked()) return platformStatus();
  if (orgId) {
    const org = await prisma.platOrganization
      .findUnique({ where: { id: orgId }, select: ORG_LLM_SELECT })
      .catch(() => null);
    const provider = org ? effectiveOrgProvider(org) : null;
    if (org && provider === "bedrock") {
      return {
        configured: true,
        locked: false,
        provider: "bedrock",
        source: "org",
        hint: maskSecret(org.bedrockAccessKeyId!),
        model: org.bedrockModel!,
        region: org.bedrockRegion,
      };
    }
    if (org && provider === "anthropic") {
      return {
        configured: true,
        locked: false,
        provider: "anthropic",
        source: "org",
        hint: org.anthropicKeyHint ?? null,
        model: org.anthropicModel ?? DEFAULT_MODEL,
        region: null,
      };
    }
  }
  return platformStatus();
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

/** Validate-on-save for a per-org Bedrock config: a throwaway client with the
 * supplied credentials makes a minimal call, so a bad region, model id, or AWS
 * key pair is rejected before anything is persisted. */
export async function validateBedrockConfig(
  region: string,
  model: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<void> {
  try {
    await new AnthropicBedrock({
      awsRegion: region,
      awsAccessKey: accessKeyId,
      awsSecretKey: secretAccessKey,
    }).messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DomainError(`AWS Bedrock validation failed: ${msg}`);
  }
}

/** Translate a raw Anthropic SDK error into a clean, user-facing LlmError — or null
 * if `err` isn't a provider error (the caller then handles it generically). The raw
 * provider body (status line, JSON, request_id) is deliberately dropped from the
 * user-facing message; callers should still log the original server-side. This is
 * what turns the opaque `500 INTERNAL: 401 {…invalid x-api-key…}` into a sentence a
 * user can act on. Pass the active provider (from resolveAnthropicStatus) when you
 * have it, so a Bedrock failure gets AWS guidance; defaults to the platform provider. */
export function friendlyLlmError(err: unknown, provider?: string): LlmError | null {
  if (!(err instanceof APIError)) return null;
  const bedrock = (provider ?? platformProvider()) === "bedrock";
  switch ((err as { status?: number }).status) {
    case 401:
      return new LlmError(
        bedrock
          ? "AWS Bedrock rejected the request credentials — the AWS credentials are missing, expired, " +
              "or the IAM identity lacks bedrock:InvokeModel for the configured model/region."
          : "The Anthropic API key was rejected (invalid, revoked, or from the wrong account). " +
              "An org admin can set a valid key in Org Admin → AI provider, or update the platform ANTHROPIC_API_KEY.",
        "LLM_KEY_INVALID", 502);
    case 403:
      return new LlmError(
        bedrock
          ? "AWS Bedrock denied access to the requested model — check the IAM policy (bedrock:InvokeModel) " +
              "and that the model/inference-profile is enabled in this region."
          : "The Anthropic API key isn't permitted to use the requested model — check the key's plan or model access.",
        "LLM_FORBIDDEN", 502);
    case 429:
      return new LlmError(
        "The AI provider is rate-limiting right now. Wait a few seconds and try again.",
        "LLM_RATE_LIMIT", 503);
    case 400:
      return new LlmError(
        "The AI provider rejected the request (usually a model-name or payload issue, not your input). Please report this if it persists.",
        "LLM_BAD_REQUEST", 502);
    default:
      // 5xx / overloaded / APIConnectionError (network, no status) all land here.
      return new LlmError(
        "The AI provider is unavailable right now. Please try again in a moment.",
        "LLM_UNAVAILABLE", 502);
  }
}
