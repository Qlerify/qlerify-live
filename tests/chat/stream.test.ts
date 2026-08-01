// POST /chat is an SSE stream (progress / result / error events) since the
// streaming-progress change. These tests pin the wire contract the web client's
// apiStream() parser depends on:
//   - auth failures and body-validation failures stay PLAIN JSON (they reply
//     before the hijack, and the client's error/redirect handling reads JSON),
//   - once streaming starts the response is text/event-stream, every data line
//     is single-line JSON, and an upstream failure arrives as an "error" event
//     with the friendly message — not a raw provider dump.
// No LLM provider is configured in the test env, so a valid request fails inside
// runAgentTurn at getAnthropicClient() — which exercises the full hijack →
// stream → error-event → end path without any network call.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { newId } from "../../src/platform/ids.js";

const SFX = `chatsse${Date.now().toString(36)}`;
const SUBJECT = `chat-sse-${SFX}`;

let app: FastifyInstance;
const caId = newId();
const orgId = newId();
let identityId: string;

const ENV_KEYS = ["ANTHROPIC_API_KEY", "LLM_PROVIDER", "LLM_SETTINGS_LOCKED"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Force the "no provider configured" state regardless of the developer's .env.
  // The client cache in src/llm/anthropic.ts fingerprints these vars, so the
  // change takes effect without an explicit cache flush.
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }

  app = await buildServer();
  await prisma.platCustomerAccount.create({ data: { id: caId, name: `CA ${SFX}` } });
  await prisma.platOrganization.create({ data: { id: orgId, customerAccountId: caId, name: `Org ${SFX}`, slug: `org-${SFX}` } });
  identityId = (await prisma.platIdentity.create({ data: { id: newId(), subject: SUBJECT } })).id;
  await prisma.platOrgMembership.create({ data: { id: newId(), identityId, organizationId: orgId } });
});

afterAll(async () => {
  await prisma.platOrgMembership.deleteMany({ where: { organizationId: orgId } });
  await prisma.platIdentity.deleteMany({ where: { id: identityId } });
  await prisma.platOrganization.deleteMany({ where: { id: orgId } });
  await prisma.platCustomerAccount.deleteMany({ where: { id: caId } });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await app?.close();
});

const AUTHED = { authorization: `Bearer ${SUBJECT}` };

/** Parse an SSE body into [{event, data}] frames (comments/heartbeats dropped). */
function parseSse(body: string): Array<{ event: string; data: any }> {
  return body.split("\n\n").filter((b) => b.trim()).flatMap((block) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    return dataLines.length ? [{ event, data: JSON.parse(dataLines.join("\n")) }] : [];
  });
}

describe("POST /chat SSE contract", () => {
  it("replies plain-JSON 401 (not a stream) when unauthenticated", async () => {
    const res = await app.inject({
      method: "POST", url: "/chat",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("replies plain-JSON 400 (not a stream) on an empty messages[]", async () => {
    const res = await app.inject({
      method: "POST", url: "/chat", headers: AUTHED, payload: { messages: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("streams a friendly error event when no LLM provider is configured", async () => {
    const res = await app.inject({
      method: "POST", url: "/chat", headers: AUTHED,
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const frames = parseSse(res.body);
    const errFrame = frames.find((f) => f.event === "error");
    expect(errFrame, `frames: ${JSON.stringify(frames)}`).toBeTruthy();
    // The friendly no-provider DomainError, not a raw stack or provider body.
    expect(errFrame!.data.message).toMatch(/Anthropic|provider/i);
    expect(res.body).not.toMatch(/x-api-key|request_id|\n\s+at /);
    // Every data line must be single-line JSON — apiStream parses frame-by-frame.
    for (const line of res.body.split("\n")) {
      if (line.startsWith("data:")) expect(() => JSON.parse(line.slice(5))).not.toThrow();
    }
  });
});
