// The LLM client seam — full resolution matrix across the three deployment
// states (locked / open-with-fallback / open-without-fallback), both providers
// (first-party Anthropic API / AWS Bedrock), and both config owners (org / env).
// Model-INDEPENDENT: builds its own customer-account / org fixtures.
//
// Proves:
//   - platform fallback: env Anthropic key and env Bedrock config each build the
//     right client; missing config fails with a setup-oriented error
//   - per-org config: an org's Anthropic key (incl. the legacy null-provider row)
//     and an org's own Bedrock credentials resolve to org-scoped clients with the
//     decrypted secrets actually reaching the SDK client
//   - LOCKED: LLM_SETTINGS_LOCKED routes every org to the platform client and
//     reports locked status; assertLlmBootConfig refuses a locked-but-empty deploy
//   - caching: config rotation and provider switches take effect without explicit
//     invalidation (fingerprint bust); env changes re-fingerprint the platform slot
//   - no secret material ever appears in a status payload

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { encryptSecret } from "../../src/platform/secrets/secret-box.js";
import {
  assertLlmBootConfig,
  getAnthropicClient,
  invalidateAnthropicCache,
  llmSettingsLocked,
  resolveAnthropicStatus,
} from "../../src/llm/anthropic.js";
import type { TenantContext } from "../../src/platform/types.js";

const SFX = `llm${Date.now().toString(36)}`;
const caId = newId();
const orgAnthropicId = newId(); // org with its own Anthropic key + model override
const orgLegacyId = newId(); // pre-provider-column org: key set, llmProvider null
const orgBedrockId = newId(); // org with its own AWS Bedrock credentials
const orgPartialId = newId(); // half-written bedrock row (no secret) → unconfigured
const orgEmptyId = newId(); // nothing configured → platform fallback
const idId = newId();

const ORG_ANTHROPIC_KEY = `sk-ant-org-${SFX}-abc123`;
const ORG_ANTHROPIC_MODEL = "claude-haiku-4-5";
const ORG_BR_REGION = "eu-north-1";
const ORG_BR_MODEL = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
const ORG_BR_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const ORG_BR_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const PLATFORM_KEY = `sk-ant-platform-${SFX}`;
const ENV_BR_REGION = "us-east-1";
const ENV_BR_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const LLM_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "LLM_PROVIDER",
  "LLM_SETTINGS_LOCKED",
  "BEDROCK_REGION",
  "BEDROCK_MODEL",
  "AWS_REGION",
] as const;
let savedEnv: Record<string, string | undefined>;

function ctxFor(organizationId: string): TenantContext {
  return { organizationId, principal: { id: idId, type: "identity" }, identityId: idId, subject: `llm-${SFX}` };
}

const allOrgIds = [orgAnthropicId, orgLegacyId, orgBedrockId, orgPartialId, orgEmptyId];

beforeAll(async () => {
  savedEnv = Object.fromEntries(
    ["PLATFORM_ENCRYPTION_KEY", ...LLM_ENV_VARS].map((k) => [k, process.env[k]]),
  );
  process.env.PLATFORM_ENCRYPTION_KEY = "0".repeat(64); // deterministic crypto

  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({
    data: {
      id: orgAnthropicId, customerAccountId: caId, name: `OrgA ${SFX}`, slug: `orga-${SFX}`,
      llmProvider: "anthropic",
      anthropicKeyCiphertext: encryptSecret(ORG_ANTHROPIC_KEY),
      anthropicKeyHint: "sk-ant-…c123",
      anthropicModel: ORG_ANTHROPIC_MODEL,
    },
  });
  await prisma.platOrganization.create({
    data: {
      id: orgLegacyId, customerAccountId: caId, name: `OrgL ${SFX}`, slug: `orgl-${SFX}`,
      // llmProvider deliberately NULL — a row saved before the provider column existed
      anthropicKeyCiphertext: encryptSecret(ORG_ANTHROPIC_KEY),
      anthropicKeyHint: "sk-ant-…c123",
    },
  });
  await prisma.platOrganization.create({
    data: {
      id: orgBedrockId, customerAccountId: caId, name: `OrgB ${SFX}`, slug: `orgb-${SFX}`,
      llmProvider: "bedrock",
      bedrockRegion: ORG_BR_REGION,
      bedrockModel: ORG_BR_MODEL,
      bedrockAccessKeyId: ORG_BR_KEY_ID,
      bedrockSecretCiphertext: encryptSecret(ORG_BR_SECRET),
      bedrockSecretHint: "wJalrXU…EKEY",
    },
  });
  await prisma.platOrganization.create({
    data: {
      id: orgPartialId, customerAccountId: caId, name: `OrgP ${SFX}`, slug: `orgp-${SFX}`,
      llmProvider: "bedrock", // half-written: region+model but no credentials
      bedrockRegion: ORG_BR_REGION,
      bedrockModel: ORG_BR_MODEL,
    },
  });
  await prisma.platOrganization.create({
    data: { id: orgEmptyId, customerAccountId: caId, name: `OrgE ${SFX}`, slug: `orge-${SFX}` },
  });
});

afterAll(async () => {
  await prisma.platOrganization.deleteMany({ where: { id: { in: allOrgIds } } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  // Each test declares exactly the env it needs. Org cache entries are keyed on
  // config fingerprints; drop them anyway so cross-test order can never matter.
  for (const k of LLM_ENV_VARS) delete process.env[k];
  for (const id of allOrgIds) invalidateAnthropicCache(id);
});

describe("platform fallback (no org context)", () => {
  it("state 3 (open, no fallback): nothing configured → clear setup error + unconfigured status", async () => {
    await expect(getAnthropicClient()).rejects.toThrow(/No Anthropic key available/);
    const status = await resolveAnthropicStatus();
    expect(status).toMatchObject({ configured: false, locked: false, provider: "none", source: "none", hint: null });
  });

  it("env Anthropic key → first-party client on the platform default", async () => {
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    const r = await getAnthropicClient();
    expect(r.client).toBeInstanceOf(Anthropic);
    expect(r.client).not.toBeInstanceOf(AnthropicBedrock);
    expect((r.client as { apiKey?: string | null }).apiKey).toBe(PLATFORM_KEY);
    expect(r).toMatchObject({ source: "platform", provider: "anthropic" });
    expect(await resolveAnthropicStatus()).toMatchObject({ configured: true, provider: "anthropic", source: "platform" });
  });

  it("env Bedrock config → Bedrock client with the env region/model", async () => {
    process.env.LLM_PROVIDER = "bedrock";
    process.env.BEDROCK_REGION = ENV_BR_REGION;
    process.env.BEDROCK_MODEL = ENV_BR_MODEL;
    const r = await getAnthropicClient();
    expect(r.client).toBeInstanceOf(AnthropicBedrock);
    expect((r.client as unknown as AnthropicBedrock).awsRegion).toBe(ENV_BR_REGION);
    expect(r).toMatchObject({ model: ENV_BR_MODEL, source: "platform", provider: "bedrock" });
    expect(await resolveAnthropicStatus()).toMatchObject({
      configured: true, provider: "bedrock", source: "platform", region: ENV_BR_REGION, model: ENV_BR_MODEL,
    });
  });

  it("env Bedrock with missing region/model → setup-oriented errors, unconfigured status", async () => {
    process.env.LLM_PROVIDER = "bedrock";
    await expect(getAnthropicClient()).rejects.toThrow(/BEDROCK_REGION/);
    process.env.BEDROCK_REGION = ENV_BR_REGION;
    await expect(getAnthropicClient()).rejects.toThrow(/BEDROCK_MODEL/);
    expect(await resolveAnthropicStatus()).toMatchObject({ configured: false, provider: "none", source: "none" });
  });

  it("env changes re-fingerprint the platform slot (no restart, no explicit invalidation)", async () => {
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    const a = await getAnthropicClient();
    expect((a.client as { apiKey?: string | null }).apiKey).toBe(PLATFORM_KEY);

    process.env.ANTHROPIC_API_KEY = `${PLATFORM_KEY}-rotated`;
    const b = await getAnthropicClient();
    expect((b.client as { apiKey?: string | null }).apiKey).toBe(`${PLATFORM_KEY}-rotated`);

    process.env.LLM_PROVIDER = "bedrock";
    process.env.BEDROCK_REGION = ENV_BR_REGION;
    process.env.BEDROCK_MODEL = ENV_BR_MODEL;
    expect((await getAnthropicClient()).client).toBeInstanceOf(AnthropicBedrock);
  });
});

describe("per-org config (unlocked)", () => {
  it("org Anthropic key: decrypted key reaches the client; org model override wins", async () => {
    const r = await runWithTenant(ctxFor(orgAnthropicId), () => getAnthropicClient());
    expect(r.client).toBeInstanceOf(Anthropic);
    expect((r.client as { apiKey?: string | null }).apiKey).toBe(ORG_ANTHROPIC_KEY);
    expect(r).toMatchObject({ model: ORG_ANTHROPIC_MODEL, source: "org", provider: "anthropic" });
  });

  it("legacy org (key set, llmProvider null) still resolves as Anthropic", async () => {
    const r = await runWithTenant(ctxFor(orgLegacyId), () => getAnthropicClient());
    expect(r).toMatchObject({ source: "org", provider: "anthropic" });
    expect((r.client as { apiKey?: string | null }).apiKey).toBe(ORG_ANTHROPIC_KEY);
  });

  it("org Bedrock: the org's own decrypted AWS credentials reach the client", async () => {
    const r = await runWithTenant(ctxFor(orgBedrockId), () => getAnthropicClient());
    expect(r.client).toBeInstanceOf(AnthropicBedrock);
    const br = r.client as unknown as AnthropicBedrock;
    expect(br.awsRegion).toBe(ORG_BR_REGION);
    expect(br.awsAccessKey).toBe(ORG_BR_KEY_ID);
    expect(br.awsSecretKey).toBe(ORG_BR_SECRET);
    expect(r).toMatchObject({ model: ORG_BR_MODEL, source: "org", provider: "bedrock" });
  });

  it("half-written Bedrock row is treated as unconfigured → platform fallback", async () => {
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    const r = await runWithTenant(ctxFor(orgPartialId), () => getAnthropicClient());
    expect(r).toMatchObject({ source: "platform", provider: "anthropic" });
    // …and with no platform fallback either, it fails like an unconfigured org.
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runWithTenant(ctxFor(orgPartialId), () => getAnthropicClient())).rejects.toThrow(/No Anthropic key/);
  });

  it("unconfigured org falls back to the platform default", async () => {
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    const r = await runWithTenant(ctxFor(orgEmptyId), () => getAnthropicClient());
    expect(r).toMatchObject({ source: "platform", provider: "anthropic" });
  });

  it("org status carries masked hints for both providers", async () => {
    const a = await runWithTenant(ctxFor(orgAnthropicId), () => resolveAnthropicStatus());
    expect(a).toMatchObject({ configured: true, locked: false, provider: "anthropic", source: "org", model: ORG_ANTHROPIC_MODEL });
    const b = await runWithTenant(ctxFor(orgBedrockId), () => resolveAnthropicStatus());
    expect(b).toMatchObject({ configured: true, locked: false, provider: "bedrock", source: "org", region: ORG_BR_REGION, model: ORG_BR_MODEL });
    expect(b.hint).toBeTruthy(); // masked access-key preview
  });

  it("a config rotation takes effect WITHOUT explicit invalidation (fingerprint bust)", async () => {
    const rotated = `sk-ant-org-${SFX}-rotated`;
    await runWithTenant(ctxFor(orgAnthropicId), () => getAnthropicClient()); // warm the cache
    await prisma.platOrganization.update({
      where: { id: orgAnthropicId },
      data: { anthropicKeyCiphertext: encryptSecret(rotated) },
    });
    const r = await runWithTenant(ctxFor(orgAnthropicId), () => getAnthropicClient());
    expect((r.client as { apiKey?: string | null }).apiKey).toBe(rotated);
    // restore for later tests
    await prisma.platOrganization.update({
      where: { id: orgAnthropicId },
      data: { anthropicKeyCiphertext: encryptSecret(ORG_ANTHROPIC_KEY) },
    });
  });

  it("a provider SWITCH takes effect without explicit invalidation", async () => {
    await runWithTenant(ctxFor(orgLegacyId), () => getAnthropicClient()); // warm as anthropic
    await prisma.platOrganization.update({
      where: { id: orgLegacyId },
      data: {
        llmProvider: "bedrock",
        bedrockRegion: ORG_BR_REGION,
        bedrockModel: ORG_BR_MODEL,
        bedrockAccessKeyId: ORG_BR_KEY_ID,
        bedrockSecretCiphertext: encryptSecret(ORG_BR_SECRET),
      },
    });
    const r = await runWithTenant(ctxFor(orgLegacyId), () => getAnthropicClient());
    expect(r.client).toBeInstanceOf(AnthropicBedrock);
    // restore the legacy shape
    await prisma.platOrganization.update({
      where: { id: orgLegacyId },
      data: {
        llmProvider: null, bedrockRegion: null, bedrockModel: null,
        bedrockAccessKeyId: null, bedrockSecretCiphertext: null,
      },
    });
  });
});

describe("no first-party key on Bedrock wire requests", () => {
  // The base SDK falls back to env ANTHROPIC_API_KEY when a client is built
  // without an apiKey, which would attach it as an x-api-key header on every
  // SigV4-signed Bedrock request — sending the platform's Anthropic key to AWS
  // and echoing it back inside AWS SignatureDoesNotMatch error bodies (which
  // quote all signed headers verbatim). buildRequest exposes the merged
  // pre-flight headers without touching the network.
  async function requestHeaders(client: unknown): Promise<Headers> {
    const { req } = await (
      client as { buildRequest: (o: object) => Promise<{ req: { headers: ConstructorParameters<typeof Headers>[0] } }> }
    ).buildRequest({
      method: "post",
      path: "/v1/messages",
      body: { model: ORG_BR_MODEL, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    });
    return new Headers(req.headers);
  }

  it("org Bedrock client: env ANTHROPIC_API_KEY never leaks into the request", async () => {
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    const r = await runWithTenant(ctxFor(orgBedrockId), () => getAnthropicClient());
    expect(r.client).toBeInstanceOf(AnthropicBedrock);
    expect((await requestHeaders(r.client)).get("x-api-key")).toBeNull();
  });

  it("platform Bedrock client: env ANTHROPIC_API_KEY never leaks into the request", async () => {
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    process.env.LLM_PROVIDER = "bedrock";
    process.env.BEDROCK_REGION = ENV_BR_REGION;
    process.env.BEDROCK_MODEL = ENV_BR_MODEL;
    const r = await getAnthropicClient();
    expect(r.client).toBeInstanceOf(AnthropicBedrock);
    expect((await requestHeaders(r.client)).get("x-api-key")).toBeNull();
  });

  it("first-party clients still send their key (the strip is Bedrock-only)", async () => {
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    const r = await getAnthropicClient();
    expect((await requestHeaders(r.client)).get("x-api-key")).toBe(PLATFORM_KEY);
  });
});

describe("state 1: LOCKED (LLM_SETTINGS_LOCKED=true)", () => {
  it("parses the lock flag", () => {
    for (const v of ["true", "TRUE", "1", "yes"]) {
      process.env.LLM_SETTINGS_LOCKED = v;
      expect(llmSettingsLocked()).toBe(true);
    }
    for (const v of ["", "false", "0", "no", "nonsense"]) {
      process.env.LLM_SETTINGS_LOCKED = v;
      expect(llmSettingsLocked()).toBe(false);
    }
  });

  it("an org with its own Bedrock config is routed to the platform Anthropic client", async () => {
    process.env.LLM_SETTINGS_LOCKED = "true";
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    const r = await runWithTenant(ctxFor(orgBedrockId), () => getAnthropicClient());
    expect(r.client).toBeInstanceOf(Anthropic);
    expect(r.client).not.toBeInstanceOf(AnthropicBedrock);
    expect((r.client as { apiKey?: string | null }).apiKey).toBe(PLATFORM_KEY);
    expect(r).toMatchObject({ source: "platform", provider: "anthropic" });
  });

  it("an org with its own Anthropic key is routed to the platform Bedrock client", async () => {
    process.env.LLM_SETTINGS_LOCKED = "true";
    process.env.LLM_PROVIDER = "bedrock";
    process.env.BEDROCK_REGION = ENV_BR_REGION;
    process.env.BEDROCK_MODEL = ENV_BR_MODEL;
    const r = await runWithTenant(ctxFor(orgAnthropicId), () => getAnthropicClient());
    expect(r.client).toBeInstanceOf(AnthropicBedrock);
    expect((r.client as unknown as AnthropicBedrock).awsRegion).toBe(ENV_BR_REGION);
    expect(r).toMatchObject({ model: ENV_BR_MODEL, source: "platform", provider: "bedrock" });
  });

  it("status reports the env pin (locked, provider, model, region) — org config invisible", async () => {
    process.env.LLM_SETTINGS_LOCKED = "true";
    process.env.LLM_PROVIDER = "bedrock";
    process.env.BEDROCK_REGION = ENV_BR_REGION;
    process.env.BEDROCK_MODEL = ENV_BR_MODEL;
    const status = await runWithTenant(ctxFor(orgBedrockId), () => resolveAnthropicStatus());
    expect(status).toMatchObject({
      configured: true, locked: true, provider: "bedrock", source: "platform",
      region: ENV_BR_REGION, model: ENV_BR_MODEL, hint: null,
    });
    // The org's own credentials must not surface while the deployment is locked.
    const json = JSON.stringify(status);
    expect(json).not.toContain(ORG_BR_KEY_ID);
    expect(json).not.toContain(ORG_BR_SECRET);
  });
});

describe("boot guard (assertLlmBootConfig)", () => {
  it("unlocked deployments boot with or without a platform provider", () => {
    expect(() => assertLlmBootConfig()).not.toThrow(); // nothing configured, unlocked → ok
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    expect(() => assertLlmBootConfig()).not.toThrow();
  });

  it("locked WITHOUT a working provider refuses to boot", () => {
    process.env.LLM_SETTINGS_LOCKED = "true";
    expect(() => assertLlmBootConfig()).toThrow(/LLM_SETTINGS_LOCKED/);
    process.env.LLM_PROVIDER = "bedrock";
    expect(() => assertLlmBootConfig()).toThrow(/BEDROCK_REGION|region/);
    process.env.BEDROCK_REGION = ENV_BR_REGION;
    expect(() => assertLlmBootConfig()).toThrow(/BEDROCK_MODEL/);
  });

  it("locked WITH a working provider boots", () => {
    process.env.LLM_SETTINGS_LOCKED = "true";
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    expect(() => assertLlmBootConfig()).not.toThrow();

    delete process.env.ANTHROPIC_API_KEY;
    process.env.LLM_PROVIDER = "bedrock";
    process.env.BEDROCK_REGION = ENV_BR_REGION;
    process.env.BEDROCK_MODEL = ENV_BR_MODEL;
    expect(() => assertLlmBootConfig()).not.toThrow();
  });
});

describe("no secret material in any status payload", () => {
  it.each([
    ["org anthropic", orgAnthropicId],
    ["org bedrock", orgBedrockId],
    ["org empty (platform fallback)", orgEmptyId],
  ])("%s", async (_label, orgId) => {
    process.env.ANTHROPIC_API_KEY = PLATFORM_KEY;
    const status = await runWithTenant(ctxFor(orgId), () => resolveAnthropicStatus());
    const json = JSON.stringify(status);
    expect(json).not.toContain(ORG_ANTHROPIC_KEY);
    expect(json).not.toContain(ORG_BR_SECRET);
    expect(json).not.toContain(ORG_BR_KEY_ID); // even the access-key ID only surfaces masked
    expect(json).not.toContain(PLATFORM_KEY);
  });
});
