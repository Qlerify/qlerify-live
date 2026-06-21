// Model sync — fetch the latest Qlerify workflow model on demand and keep a
// local, navigable version history so the running app can roll back and forward.
//
// The model is pulled straight from the Qlerify modeller over the same MCP
// HTTP endpoint the `download` skill uses (JSON-RPC `get_workflow`), and the
// `.specification` payload is written verbatim to .qlerify/workflow.json — no
// parsing or normalization, matching how that file was produced in the first
// place. The existing loader (model.ts) then hot-reloads it.
//
// Version history lives under .qlerify/history/:
//   manifest.json          — ordered timeline + a `current` pointer
//   <id>.json              — the full workflow snapshot for each version
// Fetching appends a new version at the tip; rollback/forward just move the
// pointer and re-materialize that snapshot into workflow.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

import { QLERIFY_DIR, reloadOntology } from "./model.js";

const HISTORY_DIR = join(QLERIFY_DIR, "history");
const MANIFEST_PATH = join(HISTORY_DIR, "manifest.json");
const WORKFLOW_PATH = join(QLERIFY_DIR, "workflow.json");
const CODEGEN_PATH = join(QLERIFY_DIR, "codegen.json");
const SOURCE_PATH = join(QLERIFY_DIR, "model-source.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VersionSummary {
  schemaVersion: number | string | null;
  boundedContext: string | null;
  events: number;
  roles: number;
  externalBoundedContexts: number;
}

interface VersionEntry {
  id: string;           // filename stem of the snapshot, e.g. "0003-1a2b3c4d"
  savedAt: string;      // ISO timestamp the version was captured
  source: "initial" | "fetch";
  sourceUrl: string | null;  // modeller workflow URL this snapshot was fetched from
                             // (best-effort for "initial"; null/absent on legacy entries)
  sourceName: string | null; // the workflow's display name at fetch time (via list_workflows)
  hash: string;         // sha256 of the snapshot JSON
  summary: VersionSummary;
}

interface Manifest {
  current: number;      // index into `versions` currently materialized on disk
  versions: VersionEntry[];
}

export interface ModelStatus {
  workflowId: string | null;
  workflowName: string | null;
  current: number;      // -1 when no history yet
  total: number;
  canBack: boolean;
  canForward: boolean;
  currentVersion: VersionEntry | null;
  versions: VersionEntry[];
}

// ---------------------------------------------------------------------------
// Qlerify MCP fetch (mirrors the `download` skill: JSON-RPC get_workflow)
// ---------------------------------------------------------------------------

interface McpCreds {
  url: string;
  apiKey: string;
}

function readMcpCreds(): McpCreds {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) {
    throw new Error("~/.claude.json not found — cannot locate Qlerify MCP credentials");
  }
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const q = cfg?.mcpServers?.qlerify;
  const url = q?.url;
  const apiKey = q?.headers?.["x-api-key"];
  if (!url || !apiKey) {
    throw new Error("Qlerify MCP server (url + x-api-key) not configured in ~/.claude.json");
  }
  return { url, apiKey };
}

function readCodegenIds(): { workflowId: string; projectId: string; workflowName: string | null } {
  if (!existsSync(CODEGEN_PATH)) {
    throw new Error(".qlerify/codegen.json not found — need workflowId + projectId to fetch the model");
  }
  const cg = JSON.parse(readFileSync(CODEGEN_PATH, "utf8"));
  if (!cg.workflowId || !cg.projectId) {
    throw new Error(".qlerify/codegen.json missing workflowId or projectId");
  }
  return { workflowId: cg.workflowId, projectId: cg.projectId, workflowName: cg.workflowName ?? null };
}

// ---------------------------------------------------------------------------
// Source config — the Qlerify modeller workflow this app pulls from, shown as
// a clickable deep link and editable in the UI. Editing the link overrides the
// project/workflow ids used by the fetch (still via MCP `get_workflow`); by
// default they come from .qlerify/codegen.json.
// ---------------------------------------------------------------------------

const QLERIFY_APP = "https://app.qlerify.com";

/** Deep link to a workflow in the Qlerify modeller. */
function modellerUrl(projectId: string, workflowId: string): string {
  return `${QLERIFY_APP}/workflow/${projectId}/${workflowId}`;
}

/** Pull the project/workflow ids out of a modeller URL. */
function parseWorkflowUrl(url: string): { projectId: string; workflowId: string } {
  const m = url.match(/\/workflow\/([0-9a-fA-F-]{8,})\/([0-9a-fA-F-]{8,})/);
  if (!m) {
    throw new Error("URL must look like https://app.qlerify.com/workflow/<projectId>/<workflowId>");
  }
  return { projectId: m[1], workflowId: m[2] };
}

interface SourceOverride { projectId: string; workflowId: string }

/** The configured override ids, or null when using codegen.json. */
export function readSourceOverride(): SourceOverride | null {
  if (!existsSync(SOURCE_PATH)) return null;
  try {
    const o = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
    return o?.projectId && o?.workflowId ? { projectId: o.projectId, workflowId: o.workflowId } : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, when blank) the source override from a modeller URL. */
export function writeSourceOverride(url: string | null): void {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    if (existsSync(SOURCE_PATH)) unlinkSync(SOURCE_PATH);
    return;
  }
  const ids = parseWorkflowUrl(trimmed);
  writeFileSync(SOURCE_PATH, JSON.stringify({ url: modellerUrl(ids.projectId, ids.workflowId), ...ids }, null, 2) + "\n");
}

/** Project/workflow ids the next fetch will use (override, else codegen.json). */
function effectiveIds(): { projectId: string; workflowId: string } {
  const o = readSourceOverride();
  if (o) return o;
  const c = readCodegenIds();
  return { projectId: c.projectId, workflowId: c.workflowId };
}

export interface ModelSource {
  workflowUrl: string;        // the editable, clickable modeller link (effective)
  defaultWorkflowUrl: string; // the link derived from codegen.json
  isOverride: boolean;
  projectId: string;
  workflowId: string;
}

export function getModelSource(): ModelSource {
  let codegen = { projectId: "", workflowId: "" };
  try {
    const c = readCodegenIds();
    codegen = { projectId: c.projectId, workflowId: c.workflowId };
  } catch {
    /* codegen.json optional for display */
  }
  const o = readSourceOverride();
  const eff = o ?? codegen;
  return {
    workflowUrl: eff.projectId && eff.workflowId ? modellerUrl(eff.projectId, eff.workflowId) : "",
    defaultWorkflowUrl: codegen.projectId && codegen.workflowId ? modellerUrl(codegen.projectId, codegen.workflowId) : "",
    isOverride: !!o,
    projectId: eff.projectId,
    workflowId: eff.workflowId,
  };
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

/** Fetch a workflow's `.specification` object from the Qlerify modeller via MCP,
 * for explicit (projectId, workflowId). */
async function fetchSpecificationFor(projectId: string, workflowId: string): Promise<unknown> {
  const { url, apiKey } = readMcpCreds();
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

/** Fetch the workflow's `.specification` from the configured source (override URL
 * or codegen.json) — the demo/system model fetch. */
async function fetchSpecification(): Promise<unknown> {
  const { workflowId, projectId } = effectiveIds();
  return fetchSpecificationFor(projectId, workflowId);
}

/** Fetch + serialize a Qlerify model from a modeller workflow URL — used to set a
 * project's OWN model from a link. Returns the workflow.json text. Throws a clear
 * error on a malformed URL or a fetch failure. */
export async function fetchSpecificationFromUrl(workflowUrl: string): Promise<string> {
  const { projectId, workflowId } = parseWorkflowUrl(workflowUrl); // throws on a bad URL
  const spec = await fetchSpecificationFor(projectId, workflowId);
  return serialize(spec);
}

// ---------------------------------------------------------------------------
// History store
// ---------------------------------------------------------------------------

/** Stable 2-space serialization used both on disk and for hashing. */
function serialize(spec: unknown): string {
  return JSON.stringify(spec, null, 2) + "\n";
}

function hashOf(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

function summarize(spec: any): VersionSummary {
  const countEvents = (de: unknown) => (de && typeof de === "object" ? Object.keys(de as object).length : 0);
  // Total events span the primary bounded context plus every external one, so
  // this matches what the loaded ontology actually exposes.
  const external = spec?.externalBoundedContexts ?? {};
  let events = countEvents(spec?.domainEvents);
  for (const bc of Object.values(external)) events += countEvents((bc as any)?.domainEvents);
  return {
    schemaVersion: spec?.version ?? null,
    boundedContext: spec?.boundedContext ?? null,
    events,
    roles: Array.isArray(spec?.roles) ? spec.roles.length : 0,
    externalBoundedContexts: Object.keys(external).length,
  };
}

function loadManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) return { current: -1, versions: [] };
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

function saveManifest(m: Manifest): void {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

function snapshotPath(id: string): string {
  return join(HISTORY_DIR, `${id}.json`);
}

function makeId(seq: number, hash: string): string {
  return `${String(seq).padStart(4, "0")}-${hash.slice(0, 8)}`;
}

/** The effective modeller URL the next fetch would pull from, or null if none
 * is configured. Recorded on each version so an old snapshot's origin survives
 * later edits to the source URL. */
function currentSourceUrl(): string | null {
  return getModelSource().workflowUrl || null;
}

/** Best-effort workflow display name for the codegen default, without a network
 * call — used for the synchronous initial-version capture. */
function currentSourceNameSync(): string | null {
  try {
    return readCodegenIds().workflowName;
  } catch {
    return null;
  }
}

/** Look up a workflow's display name via the MCP `list_workflows` tool. Returns
 * null on any failure — naming is a nicety, never a reason to fail a fetch. */
async function fetchWorkflowNameFromMcp(projectId: string, workflowId: string): Promise<string | null> {
  const { url, apiKey } = readMcpCreds();
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_workflows", arguments: { projectId } },
    }),
  });
  if (!res.ok) return null;
  const env = parseRpcEnvelope(await res.text());
  if (env.error) return null;
  const text = env?.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  const payload = JSON.parse(text);
  const list: any[] = Array.isArray(payload?.workflows) ? payload.workflows : [];
  const match = list.find((w) => w?.id === workflowId);
  return typeof match?.name === "string" ? match.name : null;
}

/** Resolve the display name for a (projectId, workflowId): the codegen name when
 * it matches (free), else asked from the modeller. Best-effort — null on error. */
async function resolveWorkflowName(projectId: string, workflowId: string): Promise<string | null> {
  try {
    const c = readCodegenIds();
    if (c.projectId === projectId && c.workflowId === workflowId && c.workflowName) return c.workflowName;
  } catch {
    /* codegen optional */
  }
  try {
    return await fetchWorkflowNameFromMcp(projectId, workflowId);
  } catch {
    return null;
  }
}

/** Capture a serialized spec as a new version file + manifest entry, and make
 * it the current version. Returns the entry. Does not touch workflow.json. */
function appendVersion(m: Manifest, serialized: string, source: "initial" | "fetch", sourceUrl: string | null, sourceName: string | null): VersionEntry {
  const hash = hashOf(serialized);
  const id = makeId(m.versions.length, hash);
  const entry: VersionEntry = {
    id,
    savedAt: new Date().toISOString(),
    source,
    sourceUrl,
    sourceName,
    hash,
    summary: summarize(JSON.parse(serialized)),
  };
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(snapshotPath(id), serialized);
  m.versions.push(entry);
  m.current = m.versions.length - 1;
  return entry;
}

/** On first use, fold the model already on disk into the history so it is
 * never lost and remains reachable via rollback. Its origin is unknown, so we
 * record the currently-configured source as a best-effort guess. */
function ensureInitialVersion(m: Manifest): void {
  if (m.versions.length > 0 || !existsSync(WORKFLOW_PATH)) return;
  const current = readFileSync(WORKFLOW_PATH, "utf8");
  appendVersion(m, current, "initial", currentSourceUrl(), currentSourceNameSync());
}

/** Write a version's snapshot to workflow.json and hot-reload the ontology. */
function materialize(entry: VersionEntry): void {
  const snapshot = readFileSync(snapshotPath(entry.id), "utf8");
  writeFileSync(WORKFLOW_PATH, snapshot);
  reloadOntology(); // throws if the snapshot is somehow invalid; file already written
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Re-derive each version's summary from its snapshot so historical entries
 * reflect the current counting logic (e.g. events across all bounded contexts),
 * not whatever was stored when the version was first captured. */
function withFreshSummaries(versions: VersionEntry[]): VersionEntry[] {
  return versions.map((v) => {
    const path = snapshotPath(v.id);
    if (!existsSync(path)) return v;
    try {
      return { ...v, summary: summarize(JSON.parse(readFileSync(path, "utf8"))) };
    } catch {
      return v;
    }
  });
}

function buildStatus(m: Manifest): ModelStatus {
  const versions = withFreshSummaries(m.versions);
  let workflowId: string | null = null;
  let workflowName: string | null = null;
  try {
    const ids = readCodegenIds();
    workflowId = ids.workflowId;
    workflowName = ids.workflowName;
  } catch {
    /* codegen.json optional for status */
  }
  return {
    workflowId,
    workflowName,
    current: m.current,
    total: versions.length,
    canBack: m.current > 0,
    canForward: m.current >= 0 && m.current < versions.length - 1,
    currentVersion: m.current >= 0 ? versions[m.current] : null,
    versions,
  };
}

export function modelStatus(): ModelStatus {
  return buildStatus(loadManifest());
}

/** Raw, on-disk model file as text, plus its absolute path — for viewing the
 * currently-loaded model.json in the UI and linking to it. */
export function modelFile(): { path: string; content: string } {
  if (!existsSync(WORKFLOW_PATH)) {
    throw new Error(".qlerify/workflow.json not found");
  }
  return { path: WORKFLOW_PATH, content: readFileSync(WORKFLOW_PATH, "utf8") };
}

export interface FetchResult extends ModelStatus {
  changed: boolean;
  message: string;
}

/** Fetch the latest model from the Qlerify modeller, store it, record history,
 * and hot-reload. A no-op (no new version) if the fetched model is byte-for-byte
 * identical to the current one. */
export async function fetchLatestModel(): Promise<FetchResult> {
  const spec = await fetchSpecification();
  const serialized = serialize(spec);
  const hash = hashOf(serialized);
  // The URL this pull actually came from — fetchSpecification and getModelSource
  // both resolve override-else-codegen, so this matches what was fetched.
  const sourceUrl = currentSourceUrl();
  const ids = effectiveIds();
  const sourceName = await resolveWorkflowName(ids.projectId, ids.workflowId);

  const m = loadManifest();
  ensureInitialVersion(m);

  const cur = m.current >= 0 ? m.versions[m.current] : null;
  if (cur && cur.hash === hash) {
    // No new version — but backfill source metadata onto a version that predates it.
    let touched = false;
    if (cur.sourceUrl == null && sourceUrl != null) { cur.sourceUrl = sourceUrl; touched = true; }
    if (cur.sourceName == null && sourceName != null) { cur.sourceName = sourceName; touched = true; }
    saveManifest(m); // persist any initial-version capture and/or backfill
    return {
      ...buildStatus(m),
      changed: touched,
      message: touched
        ? "Already up to date — recorded this version's source details."
        : "Already up to date — fetched model matches the current version.",
    };
  }

  const entry = appendVersion(m, serialized, "fetch", sourceUrl, sourceName);
  saveManifest(m);
  materialize(entry);
  return { ...buildStatus(m), changed: true, message: `Fetched and loaded a new model version (v${m.current + 1} of ${m.versions.length}).` };
}

/** Move the pointer one step back or forward through the version history and
 * re-materialize that model. */
export function rollModel(direction: "back" | "forward"): FetchResult {
  const m = loadManifest();
  ensureInitialVersion(m);
  const target = m.current + (direction === "back" ? -1 : 1);
  if (target < 0 || target >= m.versions.length) {
    throw new Error(`Cannot go ${direction}: already at the ${direction === "back" ? "oldest" : "newest"} version.`);
  }
  m.current = target;
  saveManifest(m);
  materialize(m.versions[target]);
  const e = m.versions[target];
  return { ...buildStatus(m), changed: true, message: `Rolled ${direction} to version v${target + 1} of ${m.versions.length} (${e.source}, ${e.savedAt.slice(0, 19).replace("T", " ")}).` };
}

/** Jump the pointer directly to any version in the history and re-materialize
 * that model. Generalizes rollModel to an arbitrary target — the version
 * sidebar's "restore" action. Forward versions stay reachable (the pointer
 * just moves), matching the back/forward model. */
export function restoreModel(index: number): FetchResult {
  const m = loadManifest();
  ensureInitialVersion(m);
  if (!Number.isInteger(index) || index < 0 || index >= m.versions.length) {
    throw new Error(`No such version: ${index} (history has ${m.versions.length}).`);
  }
  const e = m.versions[index];
  if (index === m.current) {
    return { ...buildStatus(m), changed: false, message: `Already on version v${index + 1} of ${m.versions.length}.` };
  }
  m.current = index;
  saveManifest(m);
  materialize(e);
  return { ...buildStatus(m), changed: true, message: `Restored version v${index + 1} of ${m.versions.length} (${e.source}, ${e.savedAt.slice(0, 19).replace("T", " ")}).` };
}
