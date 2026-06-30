// Per-org Qlerify BYOK — the credential seam behind the Model page's "⤓ Reload
// from link". Model-INDEPENDENT: builds its own customer-account / org fixtures.
//
// Proves:
//   - parseWorkflowUrl pins the host to app.qlerify.com (the SSRF guard): a foreign
//     host or a non-URL is rejected; a real modeller link parses to its ids
//   - resolveQlerifyCreds returns the platform-default creds when no org context /
//     no org key, and the org's own (decrypted) key when one is configured
//   - invalidateQlerifyCache lets a freshly-rotated key take effect

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { encryptSecret } from "../../src/platform/secrets/secret-box.js";
import { parseWorkflowUrl } from "../../src/ontology/sync.js";
import {
  resolveQlerifyCreds,
  resolveQlerifyStatus,
  invalidateQlerifyCache,
} from "../../src/llm/qlerify.js";
import type { TenantContext } from "../../src/platform/types.js";

const SFX = `qk${Date.now().toString(36)}`;
const caId = newId();
const orgId = newId(); // org WITH its own key
const orgNoKeyId = newId(); // org WITHOUT a key (falls back to platform)
const idId = newId();
const sub = `qk-user-${SFX}`;

const PLATFORM_URL = "https://mcp.platform.example/qlerify";
const PLATFORM_KEY = "platform-key-xyz";
const ORG_KEY = "org-secret-key-abc123";

let savedEnv: Record<string, string | undefined>;

function ctxFor(organizationId: string): TenantContext {
  return { organizationId, principal: { id: idId, type: "identity" }, identityId: idId, subject: sub };
}

beforeAll(async () => {
  savedEnv = {
    PLATFORM_ENCRYPTION_KEY: process.env.PLATFORM_ENCRYPTION_KEY,
    QLERIFY_MCP_URL: process.env.QLERIFY_MCP_URL,
    QLERIFY_MCP_API_KEY: process.env.QLERIFY_MCP_API_KEY,
  };
  // Deterministic crypto + platform default for the assertions below.
  process.env.PLATFORM_ENCRYPTION_KEY = "0".repeat(64);
  process.env.QLERIFY_MCP_URL = PLATFORM_URL;
  process.env.QLERIFY_MCP_API_KEY = PLATFORM_KEY;

  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({
    data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}`, qlerifyKeyCiphertext: encryptSecret(ORG_KEY), qlerifyKeyHint: "org-…c123" },
  });
  await prisma.platOrganization.create({
    data: { id: orgNoKeyId, customerAccountId: caId, name: `Org2 ${SFX}`, slug: `org2-${SFX}` },
  });
});

afterAll(async () => {
  await prisma.platOrganization.deleteMany({ where: { id: { in: [orgId, orgNoKeyId] } } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("parseWorkflowUrl host-pinning", () => {
  it("parses a real app.qlerify.com modeller link", () => {
    const p = parseWorkflowUrl("https://app.qlerify.com/workflow/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222");
    expect(p.projectId).toBe("11111111-1111-1111-1111-111111111111");
    expect(p.workflowId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("rejects a foreign host (SSRF guard)", () => {
    expect(() => parseWorkflowUrl("https://evil.example.com/workflow/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222")).toThrow(/app\.qlerify\.com/);
  });

  it("rejects a look-alike host embedding the path", () => {
    expect(() => parseWorkflowUrl("https://attacker.test/app.qlerify.com/workflow/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222")).toThrow();
  });

  it("rejects a non-URL string", () => {
    expect(() => parseWorkflowUrl("not a url")).toThrow();
  });
});

describe("resolveQlerifyCreds org-vs-platform", () => {
  it("uses the platform default when there is no org context", async () => {
    const creds = await resolveQlerifyCreds();
    expect(creds.source).toBe("platform");
    expect(creds.url).toBe(PLATFORM_URL);
    expect(creds.apiKey).toBe(PLATFORM_KEY);
  });

  it("uses the platform default for an org without its own key", async () => {
    const creds = await runWithTenant(ctxFor(orgNoKeyId), () => resolveQlerifyCreds());
    expect(creds.source).toBe("platform");
    expect(creds.apiKey).toBe(PLATFORM_KEY);
  });

  it("uses the org's own (decrypted) key when configured", async () => {
    const creds = await runWithTenant(ctxFor(orgId), () => resolveQlerifyCreds());
    expect(creds.source).toBe("org");
    expect(creds.apiKey).toBe(ORG_KEY);
    expect(creds.url).toBe(PLATFORM_URL); // no per-org URL override → platform endpoint
  });

  it("reports masked org status without leaking the key", async () => {
    const status = await runWithTenant(ctxFor(orgId), () => resolveQlerifyStatus());
    expect(status).toMatchObject({ configured: true, source: "org" });
    expect(JSON.stringify(status)).not.toContain(ORG_KEY);
  });

  it("picks up a rotated key after cache invalidation", async () => {
    const rotated = "org-rotated-key-999";
    await prisma.platOrganization.update({ where: { id: orgId }, data: { qlerifyKeyCiphertext: encryptSecret(rotated) } });
    invalidateQlerifyCache(orgId);
    const creds = await runWithTenant(ctxFor(orgId), () => resolveQlerifyCreds());
    expect(creds.apiKey).toBe(rotated);
  });
});
