// The cache is off by default under test — these tests opt in explicitly.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import type { RequestContext } from "../../src/platform/types.js";
import {
  cachedOrgRead,
  cachedRead,
  clearReadCache,
  invalidateCurrentReads,
  invalidateReads,
} from "../../src/platform/read-cache.js";

const ctx = (organizationId: string, workflowId: string): RequestContext => ({
  organizationId,
  workflowId,
  principal: { id: "cache-test-principal", type: "identity" },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let savedEnabled: string | undefined;
let savedTtl: string | undefined;

beforeAll(() => {
  savedEnabled = process.env.QLERIFY_READ_CACHE;
  savedTtl = process.env.READ_CACHE_TTL_MS;
  process.env.QLERIFY_READ_CACHE = "on";
});

afterAll(() => {
  if (savedEnabled === undefined) delete process.env.QLERIFY_READ_CACHE;
  else process.env.QLERIFY_READ_CACHE = savedEnabled;
  if (savedTtl === undefined) delete process.env.READ_CACHE_TTL_MS;
  else process.env.READ_CACHE_TTL_MS = savedTtl;
  clearReadCache();
});

beforeEach(() => {
  process.env.QLERIFY_READ_CACHE = "on";
  delete process.env.READ_CACHE_TTL_MS;
  clearReadCache();
});

describe("cachedRead", () => {
  it("computes once within the TTL and returns the identical value", async () => {
    let calls = 0;
    const compute = async () => ({ n: ++calls });
    const a = await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    const b = await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    expect(calls).toBe(1);
    expect(b).toBe(a);
  });

  it("never shares entries across orgs or workflows", async () => {
    let calls = 0;
    const compute = async () => ({ n: ++calls });
    const a = await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    const b = await runWithTenant(ctx("orgB", "wf1"), () => cachedRead("r", compute));
    const c = await runWithTenant(ctx("orgA", "wf2"), () => cachedRead("r", compute));
    expect(calls).toBe(3);
    expect(new Set([a.n, b.n, c.n]).size).toBe(3);
  });

  it("keys distinct requests separately", async () => {
    let calls = 0;
    const compute = async () => ++calls;
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r?limit=1", compute));
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r?limit=2", compute));
    expect(calls).toBe(2);
  });

  it("invalidateReads(org, wf) forces a recompute for that workflow only", async () => {
    let calls = 0;
    const compute = async () => ++calls;
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    await runWithTenant(ctx("orgB", "wf1"), () => cachedRead("r", compute));
    invalidateReads("orgA", "wf1");
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute)); // recomputes
    await runWithTenant(ctx("orgB", "wf1"), () => cachedRead("r", compute)); // still cached
    expect(calls).toBe(3);
  });

  it("invalidateReads(org) with no workflow wipes the org's entire cache", async () => {
    let calls = 0;
    const compute = async () => ++calls;
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    await runWithTenant(ctx("orgA", "wf2"), () => cachedRead("r", compute));
    await runWithTenant(ctx("orgB", "wf1"), () => cachedRead("r", compute));
    invalidateReads("orgA");
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute)); // recomputes
    await runWithTenant(ctx("orgA", "wf2"), () => cachedRead("r", compute)); // recomputes
    await runWithTenant(ctx("orgB", "wf1"), () => cachedRead("r", compute)); // untouched
    expect(calls).toBe(5);
  });

  it("invalidateCurrentReads uses the bound tenant", async () => {
    let calls = 0;
    const compute = async () => ++calls;
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    runWithTenant(ctx("orgA", "wf1"), () => invalidateCurrentReads());
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    expect(calls).toBe(2);
  });

  it("expires entries after the TTL", async () => {
    process.env.READ_CACHE_TTL_MS = "30";
    let calls = 0;
    const compute = async () => ++calls;
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    await sleep(45);
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    expect(calls).toBe(2);
  });

  it("bypasses when disabled and when no tenant is bound", async () => {
    let calls = 0;
    const compute = async () => ++calls;
    process.env.QLERIFY_READ_CACHE = "off";
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    await runWithTenant(ctx("orgA", "wf1"), () => cachedRead("r", compute));
    expect(calls).toBe(2);

    process.env.QLERIFY_READ_CACHE = "on";
    await cachedRead("r", compute); // no tenant context at all
    await cachedRead("r", compute);
    expect(calls).toBe(4);
  });
});

describe("cachedOrgRead", () => {
  it("is shared across the org's workflows and invalidated by ANY workflow's write", async () => {
    let calls = 0;
    const compute = async () => ++calls;
    await runWithTenant(ctx("orgA", "wf1"), () => cachedOrgRead("portfolio", compute));
    await runWithTenant(ctx("orgA", "wf2"), () => cachedOrgRead("portfolio", compute));
    expect(calls).toBe(1); // org-wide: both workflows share the entry

    invalidateReads("orgA", "wf2"); // a write in wf2 stales the org-wide view
    await runWithTenant(ctx("orgA", "wf1"), () => cachedOrgRead("portfolio", compute));
    expect(calls).toBe(2);
  });

  it("stays org-isolated", async () => {
    let calls = 0;
    const compute = async () => ++calls;
    await runWithTenant(ctx("orgA", "wf1"), () => cachedOrgRead("portfolio", compute));
    await runWithTenant(ctx("orgB", "wf1"), () => cachedOrgRead("portfolio", compute));
    expect(calls).toBe(2);
  });
});
