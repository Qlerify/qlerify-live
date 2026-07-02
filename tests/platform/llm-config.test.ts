// The per-org LLM provider WRITE path (setOrgAnthropicConfig) — validation,
// encryption-at-rest, the exactly-one-active-provider invariant, audit hygiene,
// and the SERVER-SIDE lock (LLM_SETTINGS_LOCKED rejects writes with 403 — the UI
// hiding the form is a convenience, not the boundary). Model-INDEPENDENT: builds
// its own customer-account / org fixtures.
//
// The two validate-on-save probes are mocked (they make real provider calls);
// everything else in the llm/anthropic module is the real implementation.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { decryptSecret } from "../../src/platform/secrets/secret-box.js";
import { AuthError, DomainError } from "../../src/errors.js";
import { setOrgAnthropicConfig } from "../../src/platform/provisioning/index.js";
import { validateAnthropicKey, validateBedrockConfig } from "../../src/llm/anthropic.js";

vi.mock("../../src/llm/anthropic.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/llm/anthropic.js")>();
  return {
    ...mod,
    validateAnthropicKey: vi.fn(async () => {}),
    validateBedrockConfig: vi.fn(async () => {}),
  };
});

const SFX = `lc${Date.now().toString(36)}`;
const caId = newId();
const orgId = newId();
const actorId = newId();

const API_KEY = `sk-ant-write-${SFX}-secret`;
const BR = {
  region: "eu-north-1",
  model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

let savedEnv: Record<string, string | undefined>;

const orgRow = () => prisma.platOrganization.findUniqueOrThrow({ where: { id: orgId } });
const auditRows = () =>
  prisma.platAuditEvent.findMany({ where: { organizationId: orgId }, orderBy: { occurredAt: "asc" } });

beforeAll(async () => {
  savedEnv = Object.fromEntries(
    ["PLATFORM_ENCRYPTION_KEY", "LLM_SETTINGS_LOCKED", "ANTHROPIC_API_KEY", "LLM_PROVIDER", "BEDROCK_REGION", "BEDROCK_MODEL", "AWS_REGION"]
      .map((k) => [k, process.env[k]]),
  );
  process.env.PLATFORM_ENCRYPTION_KEY = "0".repeat(64);
  // No env fallback during this suite — the fall-back-to-platform assertions
  // must not be satisfied by a developer's real .env key.
  for (const k of ["LLM_SETTINGS_LOCKED", "LLM_PROVIDER", "ANTHROPIC_API_KEY", "BEDROCK_REGION", "BEDROCK_MODEL", "AWS_REGION"]) {
    delete process.env[k];
  }

  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({
    data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` },
  });
});

afterAll(async () => {
  await prisma.platAuditEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  delete process.env.LLM_SETTINGS_LOCKED;
  vi.mocked(validateAnthropicKey).mockClear();
  vi.mocked(validateBedrockConfig).mockClear();
});

describe("anthropic saves", () => {
  it("back-compat payload (no provider field) saves as anthropic, validated, encrypted, masked", async () => {
    const status = await setOrgAnthropicConfig(orgId, { apiKey: API_KEY, model: "claude-haiku-4-5" }, actorId);
    expect(vi.mocked(validateAnthropicKey)).toHaveBeenCalledWith(API_KEY, "claude-haiku-4-5");

    expect(status).toMatchObject({ configured: true, locked: false, provider: "anthropic", source: "org", model: "claude-haiku-4-5" });
    expect(JSON.stringify(status)).not.toContain(API_KEY); // masked hint only

    const row = await orgRow();
    expect(row.llmProvider).toBe("anthropic");
    expect(row.anthropicKeyCiphertext).toBeTruthy();
    expect(row.anthropicKeyCiphertext).not.toContain(API_KEY); // encrypted at rest
    expect(decryptSecret(row.anthropicKeyCiphertext!)).toBe(API_KEY); // …and recoverable
  });

  it("rejects a missing apiKey", async () => {
    await expect(setOrgAnthropicConfig(orgId, { provider: "anthropic" }, actorId)).rejects.toThrow(/apiKey is required/);
  });

  it("a failed validation persists NOTHING", async () => {
    const before = await orgRow();
    vi.mocked(validateAnthropicKey).mockRejectedValueOnce(new DomainError("Anthropic key validation failed: nope"));
    await expect(setOrgAnthropicConfig(orgId, { apiKey: "sk-ant-bad" }, actorId)).rejects.toThrow(/validation failed/);
    expect(await orgRow()).toEqual(before);
  });
});

describe("bedrock saves", () => {
  it("requires every field, naming the missing one — and probes nothing until complete", async () => {
    const cases: Array<[Partial<typeof BR>, RegExp]> = [
      [{ ...BR, region: "" }, /region is required/],
      [{ ...BR, model: "" }, /model is required/],
      [{ ...BR, accessKeyId: "" }, /accessKeyId is required/],
      [{ ...BR, secretAccessKey: "" }, /secretAccessKey is required/],
    ];
    for (const [patch, re] of cases) {
      await expect(setOrgAnthropicConfig(orgId, { provider: "bedrock", ...patch }, actorId)).rejects.toThrow(re);
    }
    expect(vi.mocked(validateBedrockConfig)).not.toHaveBeenCalled();
  });

  it("a complete config is validated, stored encrypted, and CLEARS the anthropic slot", async () => {
    const status = await setOrgAnthropicConfig(orgId, { provider: "bedrock", ...BR }, actorId);
    expect(vi.mocked(validateBedrockConfig)).toHaveBeenCalledWith(BR.region, BR.model, BR.accessKeyId, BR.secretAccessKey);

    expect(status).toMatchObject({
      configured: true, locked: false, provider: "bedrock", source: "org",
      region: BR.region, model: BR.model,
    });
    const json = JSON.stringify(status);
    expect(json).not.toContain(BR.secretAccessKey);
    expect(json).not.toContain(BR.accessKeyId); // only the masked hint surfaces

    const row = await orgRow();
    expect(row.llmProvider).toBe("bedrock");
    expect(row.bedrockRegion).toBe(BR.region);
    expect(row.bedrockModel).toBe(BR.model);
    expect(row.bedrockAccessKeyId).toBe(BR.accessKeyId);
    expect(row.bedrockSecretCiphertext).not.toContain(BR.secretAccessKey); // encrypted at rest
    expect(decryptSecret(row.bedrockSecretCiphertext!)).toBe(BR.secretAccessKey);
    // exactly one active provider: the earlier anthropic save is gone
    expect(row.anthropicKeyCiphertext).toBeNull();
    expect(row.anthropicKeyHint).toBeNull();
    expect(row.anthropicModel).toBeNull();
  });

  it("switching back to anthropic clears the bedrock slot", async () => {
    await setOrgAnthropicConfig(orgId, { provider: "anthropic", apiKey: API_KEY }, actorId);
    const row = await orgRow();
    expect(row.llmProvider).toBe("anthropic");
    expect(row.bedrockRegion).toBeNull();
    expect(row.bedrockModel).toBeNull();
    expect(row.bedrockAccessKeyId).toBeNull();
    expect(row.bedrockSecretCiphertext).toBeNull();
    expect(row.bedrockSecretHint).toBeNull();
  });

  it("a failed Bedrock validation persists NOTHING", async () => {
    const before = await orgRow();
    vi.mocked(validateBedrockConfig).mockRejectedValueOnce(new DomainError("AWS Bedrock validation failed: bad creds"));
    await expect(setOrgAnthropicConfig(orgId, { provider: "bedrock", ...BR }, actorId)).rejects.toThrow(/Bedrock validation failed/);
    expect(await orgRow()).toEqual(before);
  });
});

describe("clear", () => {
  it("wipes every LLM field and reverts to the platform default", async () => {
    await setOrgAnthropicConfig(orgId, { provider: "bedrock", ...BR }, actorId);
    const status = await setOrgAnthropicConfig(orgId, { clear: true }, actorId);
    expect(status).toMatchObject({ source: "none", configured: false }); // no env fallback set in this test
    const row = await orgRow();
    for (const f of [
      "llmProvider", "anthropicKeyCiphertext", "anthropicKeyHint", "anthropicModel",
      "bedrockRegion", "bedrockModel", "bedrockAccessKeyId", "bedrockSecretCiphertext", "bedrockSecretHint",
    ] as const) {
      expect(row[f], f).toBeNull();
    }
  });
});

describe("SERVER-SIDE lock (LLM_SETTINGS_LOCKED=true)", () => {
  it("rejects set AND clear with 403, persisting nothing", async () => {
    await setOrgAnthropicConfig(orgId, { apiKey: API_KEY }, actorId); // seed a config while unlocked
    const before = await orgRow();

    process.env.LLM_SETTINGS_LOCKED = "true";
    for (const patch of [
      { apiKey: "sk-ant-other" },
      { provider: "bedrock" as const, ...BR },
      { clear: true },
    ]) {
      const err = await setOrgAnthropicConfig(orgId, patch, actorId).catch((e) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect(err.status).toBe(403);
      expect(err.message).toMatch(/locked|centrally managed/i);
    }
    expect(await orgRow()).toEqual(before); // nothing changed under the lock
    expect(vi.mocked(validateAnthropicKey)).toHaveBeenCalledTimes(1); // only the unlocked seed
    expect(vi.mocked(validateBedrockConfig)).not.toHaveBeenCalled();
  });
});

describe("audit hygiene", () => {
  it("records set/clear actions with hints only — never raw secrets", async () => {
    await setOrgAnthropicConfig(orgId, { apiKey: API_KEY, model: "claude-haiku-4-5" }, actorId);
    await setOrgAnthropicConfig(orgId, { provider: "bedrock", ...BR }, actorId);
    await setOrgAnthropicConfig(orgId, { clear: true }, actorId);

    const rows = await auditRows();
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("organization.anthropicKey.set");
    expect(actions).toContain("organization.bedrockConfig.set");
    expect(actions).toContain("organization.llmConfig.clear");

    const bedrockRow = rows.filter((r) => r.action === "organization.bedrockConfig.set").at(-1)!;
    expect(bedrockRow.reason).toContain(BR.region);
    expect(bedrockRow.reason).toContain(BR.model);

    const allText = JSON.stringify(rows);
    expect(allText).not.toContain(API_KEY);
    expect(allText).not.toContain(BR.secretAccessKey);
    expect(allText).not.toContain(BR.accessKeyId); // masked in the reason line
  });
});

describe("unknown org", () => {
  it("404-shape domain error", async () => {
    await expect(setOrgAnthropicConfig(newId(), { apiKey: API_KEY }, actorId)).rejects.toThrow(/organization not found/);
  });
});
