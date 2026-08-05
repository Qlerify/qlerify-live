// Qlerify modeller access — fetch a workflow's model from the Qlerify modeller
// over the same MCP HTTP endpoint the `download` skill uses (JSON-RPC
// `get_workflow`), and validate a Qlerify API key before it is persisted.
//
// This is the seam used by the PER-WORKFLOW model flow: setting a workflow's own
// model from a modeller link goes through fetchWorkflowModelFromUrl() (which also
// carries the modeller's workflow name, so creation can default to it — the
// reload path uses the name-less fetchSpecificationFromUrl() wrapper), and the
// returned text is stored in the content-addressed ontology store. There is no
// global model file anymore — the legacy .qlerify/workflow.json materialization
// + version-history machinery has been removed.

import { DomainError } from "../errors.js";
import { resolveQlerifyCreds } from "../llm/qlerify.js";

const QLERIFY_APP = "https://app.qlerify.com";

/** The modeller that model links must be on: QLERIFY_APP_URL when set — a locally-run
 * or white-labelled Modeller, the link-side twin of QLERIFY_MCP_URL — else the hosted
 * one. It replaces the default rather than adding to it. Read per call so a dev server
 * or test can repoint it; a malformed value falls back instead of rejecting every link. */
function modeller(): URL {
  try {
    return new URL(process.env.QLERIFY_APP_URL || QLERIFY_APP);
  } catch {
    return new URL(QLERIFY_APP);
  }
}

/** Pull the project/workflow ids out of a modeller URL, pinning the host to modeller()
 * so a mistyped or foreign link is refused up front. The URL itself is never fetched —
 * only its ids are, against the MCP endpoint from resolveQlerifyCreds. For tests. */
export function parseWorkflowUrl(url: string): { projectId: string; workflowId: string } {
  const app = modeller();
  let parsed: URL;
  try {
    parsed = new URL((url ?? "").trim());
  } catch {
    throw new Error(`URL must look like ${app.origin}/workflow/<projectId>/<workflowId>`);
  }
  if (parsed.host !== app.host) {
    throw new Error(`Model link must be on ${app.host} (got "${parsed.host}")`);
  }
  const m = parsed.pathname.match(/^\/workflow\/([0-9a-fA-F-]{8,})\/([0-9a-fA-F-]{8,})(?:\/|$)/);
  if (!m) {
    throw new Error(`URL must look like ${app.origin}/workflow/<projectId>/<workflowId>`);
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

/** True when a Qlerify MCP response means the API key was rejected — signalled
 * either by the HTTP status (401/403) or a JSON-RPC auth error envelope (the
 * modeller returns code -32001 "Authentication required" for a bad/expired key). */
function isQlerifyAuthFailure(status: number, envError?: { code?: number; message?: string } | null): boolean {
  if (status === 401 || status === 403) return true;
  const code = envError?.code;
  const msg = (envError?.message ?? "").toLowerCase();
  return code === -32001 || /auth|unauthori[sz]ed|forbidden|api[ -]?key/.test(msg);
}

/** A clean, user-facing error for a rejected Qlerify key. Deliberately hides the
 * raw provider envelope (status line + JSON-RPC body) and points at where to fix
 * the key — the UI first, the env/dev fallback second. */
function qlerifyAuthError(): DomainError {
  return new DomainError(
    "Qlerify rejected the API key — it is missing, invalid, or expired. " +
      "Add or update this organisation's key in Organisation admin → Qlerify " +
      "integration. (A platform-wide default can be set via QLERIFY_MCP_API_KEY " +
      "in the server environment; in local dev the key falls back to " +
      "~/.claude.json → mcpServers.qlerify.)",
  );
}

/** Best-effort workflow name from a `get_workflow` payload. The modeller names
 * the workflow outside `.specification`; the exact key has varied, so probe the
 * known spellings. Null when the payload names nothing. Exported for tests. */
export function modellerWorkflowName(payload: unknown): string | null {
  const p = payload as Record<string, any> | null;
  const candidates = [p?.name, p?.workflowName, p?.workflow?.name, p?.title];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

/** Mirror of the ontology loader's stale-overlay guard (model.ts): an overlay
 * belongs to a model when it has no event keys, or a MAJORITY of them resolve to
 * the model's domain events (primary + external bounded contexts). An overlay
 * carried over from a previously loaded model must never name the new one. */
function overlayBelongsToModel(overlay: any, spec: any): boolean {
  const overlayKeys = Object.keys(overlay?.events ?? {});
  if (overlayKeys.length === 0) return true;
  const modelKeys = new Set(Object.keys(spec?.domainEvents ?? {}));
  for (const ctx of Object.values(spec?.externalBoundedContexts ?? {})) {
    for (const k of Object.keys((ctx as any)?.domainEvents ?? {})) modelKeys.add(k);
  }
  const matching = overlayKeys.filter((k) => modelKeys.has(k)).length;
  return matching / overlayKeys.length >= 0.5;
}

/** Best-effort workflow name from the MODEL ITSELF (upload/paste, or a link whose
 * payload names nothing): the overlay's title — honored only when the overlay
 * belongs to this model, same as the ontology's display title — else the primary
 * bounded context. Null when the model names nothing (or doesn't parse). */
export function deriveNameFromModel(workflowJson: string, overlayJson: string | null): string | null {
  let spec: any = null;
  try { spec = JSON.parse(workflowJson); } catch { /* fall through — bc stays unreadable */ }
  try {
    const overlay = overlayJson ? JSON.parse(overlayJson) : null;
    const title = overlay?.title;
    if (typeof title === "string" && title.trim() && overlayBelongsToModel(overlay, spec)) return title.trim();
  } catch { /* a bad overlay never blocks name derivation */ }
  const bc = spec?.boundedContext;
  return typeof bc === "string" && bc.trim() ? bc.trim() : null;
}

/** Normalize a candidate workflow name before it is stored: strip control and
 * format characters (bidi overrides, zero-width marks — invisible or spoofing in
 * the switcher and audit log), collapse whitespace, and cap the length (the name
 * is echoed in every workflow-list/whoami response and permanently embedded in
 * the hash-chained audit log). Null when nothing survives. */
export function sanitizeWorkflowName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/\s+/g, " ") // FIRST, so \t \n \r become separators, not deletions
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/g, " ") // a control stripped between two spaces leaves a double
    .trim()
    .slice(0, 200)
    .replace(/[\uD800-\uDBFF]$/, "") // never cut a surrogate pair in half
    .trimEnd();
  return cleaned || null;
}

/** Fetch a workflow's full `get_workflow` payload from the Qlerify modeller via
 * MCP, for explicit (projectId, workflowId). The payload carries `.specification`
 * (the model) plus modeller metadata such as the workflow's name. */
async function fetchWorkflowPayload(projectId: string, workflowId: string): Promise<unknown> {
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
    // A rejected key is a fixable config problem (→ clean DomainError, 422); any
    // other HTTP failure is a genuine upstream/transport issue (→ 502 via the
    // route's FetchError wrap). Either way, never surface the raw JSON-RPC body.
    if (isQlerifyAuthFailure(res.status)) throw qlerifyAuthError();
    await res.text().catch(() => "");
    throw new Error(`Couldn't reach the Qlerify modeller (HTTP ${res.status}). Please try again in a moment.`);
  }
  const env = parseRpcEnvelope(await res.text());
  if (env.error) {
    if (isQlerifyAuthFailure(200, env.error)) throw qlerifyAuthError();
    throw new Error(`Qlerify modeller error: ${env.error.message ?? "unknown error"}`);
  }
  const text = env?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Qlerify response missing result.content[0].text");
  }
  const payload = JSON.parse(text);
  if (payload?.specification == null) {
    throw new Error("Qlerify response has no `.specification` — nothing to store");
  }
  return payload;
}

export interface FetchedWorkflowModel {
  /** Serialized `.specification` — the workflow.json text that gets stored. */
  workflow: string;
  /** The modeller's own name for the workflow, when the payload carries one. */
  name: string | null;
}

/** Fetch + serialize a Qlerify model from a modeller workflow URL — used to set a
 * workflow's OWN model from a link. Returns the workflow.json text plus the
 * modeller's workflow name (so creation can default to it). Throws a clear error
 * on a malformed URL or a fetch failure. */
export async function fetchWorkflowModelFromUrl(workflowUrl: string): Promise<FetchedWorkflowModel> {
  const { projectId, workflowId } = parseWorkflowUrl(workflowUrl); // throws on a bad URL
  const payload = await fetchWorkflowPayload(projectId, workflowId);
  return { workflow: serialize((payload as any).specification), name: modellerWorkflowName(payload) };
}

/** Name-less variant for callers that only want the workflow.json text (reload). */
export async function fetchSpecificationFromUrl(workflowUrl: string): Promise<string> {
  return (await fetchWorkflowModelFromUrl(workflowUrl)).workflow;
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
    await res.text().catch(() => "");
    if (isQlerifyAuthFailure(res.status)) {
      throw new DomainError("That Qlerify API key was rejected (authentication failed). Check the key — it may be invalid, expired, or revoked — and try again.");
    }
    throw new DomainError(`Couldn't validate the key — the Qlerify modeller returned HTTP ${res.status}. Please try again in a moment.`);
  }
  const env = parseRpcEnvelope(await res.text());
  if (env.error) {
    if (isQlerifyAuthFailure(200, env.error)) {
      throw new DomainError("That Qlerify API key was rejected (authentication failed). Check the key — it may be invalid, expired, or revoked — and try again.");
    }
    throw new DomainError(`Couldn't validate the key — Qlerify returned: ${env.error.message ?? "unknown error"}.`);
  }
}
