// AI recommendations (twin/next-actions-ai.ts) — the two-layer contract:
// the LLM only ranks the deterministic candidate set, hallucinated items are
// dropped at validation, freshness is (model key + event-log watermark), and
// concurrent refreshes share one LLM call. The provider is mocked; the DB,
// tenant scoping, and _app_meta storage are real (shared serial test DB).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/llm/anthropic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/llm/anthropic.js")>();
  return { ...actual, getAnthropicClient: vi.fn() };
});

import { prisma } from "../../src/db.js";
import { LlmError } from "../../src/errors.js";
import { getAnthropicClient } from "../../src/llm/anthropic.js";
import {
  getRecommendations,
  refreshRecommendations,
  validateRecommendationText,
} from "../../src/twin/next-actions-ai.js";
import { computeNextActions } from "../../src/twin/next-actions.js";
import { getMeta } from "../../src/twin/projection-store.js";
import { modelHarness } from "../helpers/po-model.js";

// Same branched fixture as next-actions.test.ts: Start → Fork → (Br | Gpr) → Verify.
const cmd = (name: string) => ({ $ref: `#/schemas/commands/${name}` });
const root = { $ref: "#/schemas/entities/Case" };
const follows = (...keys: string[]) => keys.map((k) => ({ $ref: `#/domainEvents/${k}` }));
const MODEL = JSON.stringify({
  version: 1,
  boundedContext: "Compliance",
  roles: ["Sales", "Analyst", "Manager", "Engineer"],
  domainEvents: {
    Start: { event: "Case Opened", role: "Sales", command: cmd("OpenCase"), aggregateRoot: root },
    Fork: { event: "Effort Analyzed", role: "Analyst", command: cmd("AnalyzeEffort"), aggregateRoot: root, follows: follows("Start") },
    BrApproved: { event: "BR Approved", role: "Manager", command: cmd("ApproveBr"), aggregateRoot: root, follows: follows("Fork") },
    GprApproved: { event: "GPR Approved", role: "Manager", command: cmd("ApproveGpr"), aggregateRoot: root, follows: follows("Fork") },
  },
  schemas: {
    entities: { Case: { required: ["id"], fields: [{ name: "id", dataType: "string" }] } },
    commands: {
      OpenCase: { required: [], fields: [] }, AnalyzeEffort: { required: [], fields: [] },
      ApproveBr: { required: [], fields: [] }, ApproveGpr: { required: [], fields: [] },
    },
  },
});

const h = modelHarness(MODEL);
const ref = (k: string) => `#/domainEvents/${k}`;

const fire = (caseId: string, key: string, businessAt?: Date) =>
  prisma.eventLog.create({
    data: {
      eventName: key, eventRef: ref(key), boundedContext: "Compliance",
      aggregateRoot: "Case", aggregateId: caseId, caseId, role: "Analyst",
      payload: "{}", provenance: "simulated",
      organizationId: h.orgId, workflowId: h.workflowId,
      ...(businessAt ? { businessAt } : {}),
    },
  });

// One shared mock client whose reply text each test sets.
let llmReply = "";
const createMock = vi.fn(async (_req: { messages: Array<{ content: string }> }) => ({
  content: [{ type: "text", text: llmReply }],
}));
const mockedResolver = vi.mocked(getAnthropicClient);

beforeAll(async () => {
  mockedResolver.mockResolvedValue({
    client: { messages: { create: createMock } },
    model: "test-model",
    source: "platform",
    provider: "anthropic",
  } as unknown as Awaited<ReturnType<typeof getAnthropicClient>>);
  await fire("c1", "Start");
  await fire("c1", "Fork");
});

beforeEach(() => {
  createMock.mockClear();
});

afterAll(async () => {
  await prisma.eventLog.deleteMany({ where: { workflowId: h.workflowId } });
  await prisma.$executeRawUnsafe(`DELETE FROM "_app_meta" WHERE key = ?`, `recs:${h.workflowId}`);
  vi.restoreAllMocks();
});

describe("AI recommendations — closed-set validation, freshness, dedup", () => {
  it("refresh ranks only real candidates and drops hallucinated ones", async () => {
    llmReply = JSON.stringify({
      summary: "One case is waiting on a Manager decision.",
      items: [
        { caseId: "c1", eventRef: ref("Nonexistent"), priority: 1, why: "invented step" },
        { caseId: "ghost", eventRef: ref("BrApproved"), priority: 1, why: "invented case" },
        { caseId: "c1", eventRef: ref("GprApproved"), priority: 2, why: "Do GPR second." },
        { caseId: "c1", eventRef: ref("BrApproved"), priority: 1, why: "BR is the short branch — finish it first." },
      ],
    });
    const view = await h.run(() => refreshRecommendations());
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(view.status).toBe("fresh");
    expect(view.recs!.items.map((i) => i.eventRef)).toEqual([ref("BrApproved"), ref("GprApproved")]);
    // Dense re-ranking + role taken from the CANDIDATE, never from the LLM.
    expect(view.recs!.items[0]).toMatchObject({ priority: 1, role: "Manager", caseId: "c1" });
    expect(view.recs!.summary).toContain("Manager");
    // The prompt carried only real candidates.
    const prompt = createMock.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain(ref("BrApproved"));
    expect(prompt).not.toContain("Nonexistent");
  });

  it("stores the blob in _app_meta and GET reads it back fresh without the LLM", async () => {
    expect(await getMeta(`recs:${h.workflowId}`)).not.toBeNull();
    const view = await h.run(() => getRecommendations());
    expect(view.status).toBe("fresh");
    expect(view.dropped).toBe(0);
    expect(view.recs!.items).toHaveLength(2);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("goes stale when new events land, and drops items that left the candidate set", async () => {
    // BrApproved fires → it leaves the frontier AND the watermark moves.
    await fire("c1", "BrApproved");
    const view = await h.run(() => getRecommendations());
    expect(view.status).toBe("stale");
    // GprApproved is bypass-excluded? No — nothing downstream of it fired; it
    // stays. BrApproved is now fired → dropped from the stored items.
    expect(view.recs!.items.map((i) => i.eventRef)).toEqual([ref("GprApproved")]);
    expect(view.dropped).toBe(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("concurrent refreshes share one in-flight LLM call", async () => {
    llmReply = JSON.stringify({
      summary: "s",
      items: [{ caseId: "c1", eventRef: ref("GprApproved"), priority: 1, why: "Only open step." }],
    });
    const [a, b] = await h.run(() => Promise.all([refreshRecommendations(), refreshRecommendations()]));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // literally the same promise result
    expect((await h.run(() => getRecommendations())).status).toBe("fresh");
  });

  it("an unparsable reply throws LlmError (the deterministic list still stands)", async () => {
    llmReply = "I think you should focus on the stale cases first.";
    await expect(h.run(() => refreshRecommendations())).rejects.toThrow(LlmError);
  });

  it("an empty frontier stores an empty blob with zero LLM calls", async () => {
    const empty = modelHarness(MODEL); // fresh workflow, no EventLog rows
    const view = await empty.run(() => refreshRecommendations());
    expect(view.status).toBe("fresh");
    expect(view.recs!.items).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
    await prisma.$executeRawUnsafe(`DELETE FROM "_app_meta" WHERE key = ?`, `recs:${empty.workflowId}`);
  });
});

describe("validateRecommendationText — pure validation", () => {
  it("returns null for prose, bad JSON, and rankings with no valid item", async () => {
    const candidates = await h.run(() => computeNextActions({ limit: null })).then((r) => r.actions);
    expect(validateRecommendationText("no json here", candidates)).toBeNull();
    expect(validateRecommendationText("{ items: [not json", candidates)).toBeNull();
    expect(
      validateRecommendationText(JSON.stringify({ items: [{ caseId: "x", eventRef: "y", why: "z" }] }), candidates),
    ).toBeNull();
  });

  it("coerces bad priorities, truncates long whys, drops empty ones", async () => {
    const candidates = await h.run(() => computeNextActions({ limit: null })).then((r) => r.actions);
    const target = candidates[0]!;
    const out = validateRecommendationText(
      JSON.stringify({
        summary: "s",
        items: [
          { caseId: target.caseId, eventRef: target.eventRef, priority: "first", why: "x".repeat(500) },
          { caseId: target.caseId, eventRef: target.eventRef, priority: 2, why: "   " },
        ],
      }),
      candidates,
    );
    expect(out).not.toBeNull();
    expect(out!.items).toHaveLength(1);
    expect(out!.items[0]!.priority).toBe(1);
    expect(out!.items[0]!.why).toHaveLength(240);
  });
});

describe("computeNextActions — per-case business-time fallback", () => {
  it("one businessAt-null row must not reset a dated case's dwell to ingestion time", async () => {
    // c2's business timeline ended weeks ago; the Fork row (no source
    // timestamp, businessAt deliberately null) was ingested just now. The
    // recorded-time fallback is per CASE: it must not apply here, or the
    // stalest case would read as touched today and sort least-urgent.
    const old = new Date("2026-07-01T00:00:00Z");
    await fire("c2", "Start", old);
    await fire("c2", "Fork"); // businessAt null, occurredAt = now
    const res = await h.run(() => computeNextActions({ caseId: "c2" }));
    expect(res.actions.length).toBeGreaterThan(0);
    const a = res.actions[0]!;
    expect(a.lastAt).toBe(old.toISOString());
    expect(a.stale).toBe(true);
    expect(a.dwellDays).toBeGreaterThan(10);
  });
});
