// Per-org Qlerify BYOK — the credential seam behind the Model page's "⤓ Reload
// from link". Model-INDEPENDENT: builds its own customer-account / org fixtures.
//
// Proves:
//   - parseWorkflowUrl pins the host to app.qlerify.com (the SSRF guard): a foreign
//     host or a non-URL is rejected; a real modeller link parses to its ids
//   - resolveQlerifyCreds returns the platform-default creds when no org context /
//     no org key, and the org's own (decrypted) key when one is configured
//   - invalidateQlerifyCache lets a freshly-rotated key take effect

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { encryptSecret } from "../../src/platform/secrets/secret-box.js";
import { deriveNameFromModel, modellerWorkflowName, parseWorkflowUrl, sanitizeWorkflowName } from "../../src/ontology/sync.js";
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
  // Assert the DEFAULT modeller, so a QLERIFY_APP_URL in the developer's .env
  // (running against a local Modeller) can't turn these red.
  beforeAll(() => vi.stubEnv("QLERIFY_APP_URL", ""));
  afterAll(() => vi.unstubAllEnvs());

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

// QLERIFY_APP_URL repoints the pin at a locally-run or white-labelled modeller.
describe("parseWorkflowUrl modeller override (QLERIFY_APP_URL)", () => {
  const PATH = "/workflow/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222";
  afterEach(() => vi.unstubAllEnvs());

  // Stubbing AFTER import also proves the env is read per call, not at load.
  it("accepts the overridden host (port included) and refuses every other", () => {
    vi.stubEnv("QLERIFY_APP_URL", "http://localhost:8080");
    expect(parseWorkflowUrl(`http://localhost:8080${PATH}`).projectId).toBe("11111111-1111-1111-1111-111111111111");
    expect(() => parseWorkflowUrl(`https://app.qlerify.com${PATH}`)).toThrow(/localhost:8080/); // replaces, not adds
    expect(() => parseWorkflowUrl(`https://evil.example.com${PATH}`)).toThrow(/localhost:8080/);
  });

  it("ignores a malformed override instead of breaking every link", () => {
    vi.stubEnv("QLERIFY_APP_URL", "http://[not a url");
    expect(parseWorkflowUrl(`https://app.qlerify.com${PATH}`).projectId).toBe("11111111-1111-1111-1111-111111111111");
  });
});

// Workflow-name derivation — creating a workflow without a name takes it from
// the loaded model: the modeller payload's own name (link pulls), else the
// model's overlay title / primary bounded context.
describe("modellerWorkflowName payload probing", () => {
  it("takes the payload's top-level name", () => {
    expect(modellerWorkflowName({ name: "Order Fulfilment", specification: {} })).toBe("Order Fulfilment");
  });

  it("falls back through workflowName / workflow.name / title", () => {
    expect(modellerWorkflowName({ workflowName: "A" })).toBe("A");
    expect(modellerWorkflowName({ workflow: { name: "B" } })).toBe("B");
    expect(modellerWorkflowName({ title: "C" })).toBe("C");
  });

  it("trims, and ignores blank or non-string candidates", () => {
    expect(modellerWorkflowName({ name: "  Padded  " })).toBe("Padded");
    expect(modellerWorkflowName({ name: "   ", workflowName: 7, title: "Real" })).toBe("Real");
  });

  it("is null when the payload names nothing", () => {
    expect(modellerWorkflowName({ specification: {} })).toBeNull();
    expect(modellerWorkflowName(null)).toBeNull();
  });
});

describe("deriveNameFromModel (upload/paste fallback)", () => {
  it("prefers the overlay title over the bounded context", () => {
    expect(deriveNameFromModel(JSON.stringify({ boundedContext: "Orders" }), JSON.stringify({ title: "Order Fulfilment" }))).toBe("Order Fulfilment");
  });

  it("falls back to the primary bounded context", () => {
    expect(deriveNameFromModel(JSON.stringify({ boundedContext: "Orders" }), null)).toBe("Orders");
    expect(deriveNameFromModel(JSON.stringify({ boundedContext: "Orders" }), JSON.stringify({ title: "  " }))).toBe("Orders");
  });

  // v1's `name` — the only workflow name an uploaded/pasted workflow.json carries,
  // since there is no modeller payload to probe on that path.
  it("prefers the export's name over the bounded context", () => {
    const named = (name: unknown) => JSON.stringify({ name, boundedContext: "Orders" });
    expect(deriveNameFromModel(named("Order Fulfilment"), null)).toBe("Order Fulfilment");
    expect(deriveNameFromModel(named("  Padded  "), null)).toBe("Padded");
    expect(deriveNameFromModel(named("   "), null)).toBe("Orders"); // blank → falls through
    expect(deriveNameFromModel(named(7), null)).toBe("Orders"); // non-string → falls through
  });

  it("still lets the overlay title outrank the export's name", () => {
    const wf = JSON.stringify({ name: "Order Fulfilment", boundedContext: "Orders" });
    expect(deriveNameFromModel(wf, JSON.stringify({ title: "Renamed In Live" }))).toBe("Renamed In Live");
  });

  it("a bad overlay never blocks derivation", () => {
    expect(deriveNameFromModel(JSON.stringify({ boundedContext: "Orders" }), "not json")).toBe("Orders");
  });

  it("is null when the model names nothing or doesn't parse", () => {
    expect(deriveNameFromModel(JSON.stringify({ domainEvents: {} }), null)).toBeNull();
    expect(deriveNameFromModel("not json", null)).toBeNull();
  });

  // The stale-overlay guard (mirrors model.ts's overlayForThisModel): a title
  // from an overlay whose event keys belong to a DIFFERENT model must not name
  // the new workflow — that's the model-switch "stale labels" bug.
  it("ignores the title of a stale overlay (event keys from another model)", () => {
    const wf = JSON.stringify({ boundedContext: "Orders", domainEvents: { OrderPlaced: {} } });
    const stale = JSON.stringify({ title: "Billing Pipeline", events: { InvoiceSent: {}, PaymentTaken: {} } });
    expect(deriveNameFromModel(wf, stale)).toBe("Orders");
  });

  it("honors the title of an overlay whose event keys match (incl. external BCs)", () => {
    const wf = JSON.stringify({
      boundedContext: "Orders",
      domainEvents: { OrderPlaced: {} },
      externalBoundedContexts: { SAP: { domainEvents: { GoodsIssued: {} } } },
    });
    const matching = JSON.stringify({ title: "Order Fulfilment", events: { OrderPlaced: {}, GoodsIssued: {} } });
    expect(deriveNameFromModel(wf, matching)).toBe("Order Fulfilment");
  });
});

describe("sanitizeWorkflowName", () => {
  it("strips control and format characters (bidi override, zero-width, BEL)", () => {
    expect(sanitizeWorkflowName("Ord\u202Eers\u200B\u0007")).toBe("Orders");
    expect(sanitizeWorkflowName("\u202E\u200B\u0007")).toBeNull();
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeWorkflowName("  Order \n\t Fulfilment  ")).toBe("Order Fulfilment");
  });

  it("turns a bare newline/tab separator into a space (not a deletion)", () => {
    expect(sanitizeWorkflowName("Q3\nForecast")).toBe("Q3 Forecast");
    expect(sanitizeWorkflowName("Order\tFulfilment")).toBe("Order Fulfilment");
  });

  it("leaves no double space where a control sat between two spaces", () => {
    expect(sanitizeWorkflowName("a \u0007 b")).toBe("a b");
  });

  it("caps the length at 200 without cutting a surrogate pair in half", () => {
    expect(sanitizeWorkflowName("x".repeat(5000))!.length).toBe(200);
    const emoji = sanitizeWorkflowName("a" + "🍕".repeat(120))!;
    expect(emoji.length).toBeLessThanOrEqual(200);
    expect(/[\uD800-\uDBFF]$/.test(emoji)).toBe(false);
  });

  it("is null for blank or non-string input", () => {
    expect(sanitizeWorkflowName("   ")).toBeNull();
    expect(sanitizeWorkflowName(null)).toBeNull();
    expect(sanitizeWorkflowName(undefined)).toBeNull();
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
