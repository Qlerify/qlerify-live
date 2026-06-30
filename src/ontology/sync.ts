// Qlerify modeller access — fetch a workflow's model from the Qlerify modeller
// over the same MCP HTTP endpoint the `download` skill uses (JSON-RPC
// `get_workflow`), and validate a Qlerify API key before it is persisted.
//
// This is the seam used by the PER-WORKFLOW model flow: setting a workflow's own
// model from a modeller link goes through fetchSpecificationFromUrl(), and the
// returned text is stored in the content-addressed ontology store. There is no
// global model file anymore — the legacy .qlerify/workflow.json materialization
// + version-history machinery has been removed.

import { DomainError } from "../errors.js";
import { resolveQlerifyCreds } from "../llm/qlerify.js";

const QLERIFY_APP = "https://app.qlerify.com";
const QLERIFY_HOST = new URL(QLERIFY_APP).host; // "app.qlerify.com"

/** Pull the project/workflow ids out of a modeller URL. The host is pinned to the
 * Qlerify modeller so a caller-supplied sourceUrl can never aim the server's fetch
 * at an arbitrary host (SSRF) or at a foreign service. Exported for tests. */
export function parseWorkflowUrl(url: string): { projectId: string; workflowId: string } {
  let parsed: URL;
  try {
    parsed = new URL((url ?? "").trim());
  } catch {
    throw new Error(`URL must look like ${QLERIFY_APP}/workflow/<projectId>/<workflowId>`);
  }
  if (parsed.host !== QLERIFY_HOST) {
    throw new Error(`Model link must be on ${QLERIFY_HOST} (got "${parsed.host}")`);
  }
  const m = parsed.pathname.match(/^\/workflow\/([0-9a-fA-F-]{8,})\/([0-9a-fA-F-]{8,})(?:\/|$)/);
  if (!m) {
    throw new Error(`URL must look like ${QLERIFY_APP}/workflow/<projectId>/<workflowId>`);
  }
  return { projectId: m[1], workflowId: m[2] };
}

/** Parse an MCP HTTP response that may be plain JSON or an SSE (text/event-stream)
 * frame (`data: {...}`). Returns the decoded JSON-RPC envelope. */
function parseRpcEnvelope(raw: string): any {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // SSE: take the last non-empty `data:` line.
    const dataLines = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l && l !== "[DONE]");
    if (dataLines.length === 0) throw new Error("Unrecognized MCP response (neither JSON nor SSE)");
    return JSON.parse(dataLines[dataLines.length - 1]);
  }
}

/** Stable 2-space serialization, matching how the model is stored. */
function serialize(spec: unknown): string {
  return JSON.stringify(spec, null, 2) + "\n";
}

/** Fetch a workflow's `.specification` object from the Qlerify modeller via MCP,
 * for explicit (projectId, workflowId). */
async function fetchSpecificationFor(projectId: string, workflowId: string): Promise<unknown> {
  const { url, apiKey } = await resolveQlerifyCreds();
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_workflow", arguments: { workflowId, projectId } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Qlerify fetch failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  const env = parseRpcEnvelope(await res.text());
  if (env.error) {
    throw new Error(`Qlerify MCP error: ${env.error.message ?? JSON.stringify(env.error)}`);
  }
  const text = env?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Qlerify response missing result.content[0].text");
  }
  const payload = JSON.parse(text);
  if (payload?.specification == null) {
    throw new Error("Qlerify response has no `.specification` — nothing to store");
  }
  return payload.specification;
}

/** Fetch + serialize a Qlerify model from a modeller workflow URL — used to set a
 * workflow's OWN model from a link. Returns the workflow.json text. Throws a clear
 * error on a malformed URL or a fetch failure. */
export async function fetchSpecificationFromUrl(workflowUrl: string): Promise<string> {
  const { projectId, workflowId } = parseWorkflowUrl(workflowUrl); // throws on a bad URL
  const spec = await fetchSpecificationFor(projectId, workflowId);
  return serialize(spec);
}

/** Validate a Qlerify MCP credential by making a cheap `tools/list` call. Throws
 * DomainError on any failure so a bad key is rejected before it is ever persisted
 * (validate-on-save). Needs only a valid key — no project/workflow id. */
export async function validateQlerifyCreds(url: string, apiKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  } catch (e: any) {
    throw new DomainError(`Qlerify key validation failed: ${e?.message ?? String(e)}`);
  }
  if (!res.ok) {
    throw new DomainError(`Qlerify key validation failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  const env = parseRpcEnvelope(await res.text());
  if (env.error) {
    throw new DomainError(`Qlerify key validation failed: ${env.error.message ?? JSON.stringify(env.error)}`);
  }
}
