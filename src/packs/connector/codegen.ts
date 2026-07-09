// AI author for full-power connectors (Part 2.4). Builds a prompt from the target
// kind (entity OR value object) schema + the user's natural-language description of
// the source + the credential field names that are configured, calls Claude, and
// returns the ESM module source plus the npm packages it imports (so the runtime
// can install them). buildConnectorPrompt has no side effects (unit-testable);
// only generateConnectorModule calls out.

import Anthropic from "@anthropic-ai/sdk";
import type { EntitySchema, SchemaField } from "../../ontology/model.js";
import { getAnthropicClient } from "../../llm/anthropic.js";
import { scanImports } from "./runtime.js";

/** A schema one of the target's fields points at via `relatedEntity`. Its example
 * values are the model's allowed vocabulary for that field when data is fabricated. */
export interface RelatedSchema {
  name: string;
  kind: "entity" | "valueObject";
  schema: EntitySchema;
}

interface ConnectorGenInput {
  /** The model kind the connector must produce rows for. */
  target: EntitySchema;
  /** "entity" | "valueObject" — affects whether an id is expected. */
  targetKind: "entity" | "valueObject";
  /** The user's natural-language description of the source ("our DynamoDB users
   * table", "Pipedrive persons via REST", "the Google Sheet at …"). */
  instructions: string;
  /** The credential FIELD NAMES configured (never the values). */
  credentialKeys: string[];
  /** Configured source endpoint, if any. */
  endpoint?: string;
  /** On a self-heal turn: the error + trace from the last failed test run. */
  errorReport?: string;
  /** Schemas of the kinds the target's fields hold via `relatedEntity` (resolved
   * by the caller — this module never reads the ontology). */
  related?: RelatedSchema[];
}

interface ConnectorGenResult {
  code: string;
  deps: string[];
}

/** Deduped example values in model order, capped — the value vocabulary the model
 * records for a field. */
function exampleVocab(f: SchemaField, max = 10): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of f.exampleData ?? []) {
    if (v === undefined || v === null || v === "") continue;
    const s = JSON.stringify(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Exported for unit tests — pure (no I/O, no ontology reads). */
export function buildConnectorPrompt(input: ConnectorGenInput): string {
  const { target, targetKind, instructions, credentialKeys, endpoint, errorReport, related } = input;
  const fields = target.fields
    .map((f) => {
      const req = (target.required ?? []).includes(f.name) ? " (required)" : "";
      const vocab = exampleVocab(f, 5);
      const ex = vocab.length ? ` — e.g. ${vocab.join(", ")}` : "";
      const rel = f.relatedEntity ? ` [holds a ${f.relatedEntity}${f.array ? "[]" : ""} value object — see Related schemas]` : "";
      return `  ${f.name}: ${f.dataType ?? "string"}${req}${ex}${rel}`;
    })
    .join("\n");

  const relatedSection = (related ?? []).length
    ? [
        ``,
        `## Related schemas — what the [holds a …] fields above contain`,
        `Each related schema's example values are the model's ALLOWED VOCABULARY for the field that holds it. When you FABRICATE data (simulated/demo rows, no real source), pick those fields' values ONLY from the allowed values below — never invent variants or lookalikes. Return the value flat (the related schema's single meaningful field's value) unless asked to embed it as a nested object; either way the values must come from the allowed list. Rows read from a real source pass through as-is.`,
        ...(related ?? []).map((r) => {
          const sub = r.schema.fields
            .map((f) => {
              const vocab = exampleVocab(f);
              return `    ${f.name}: ${f.dataType ?? "string"}${vocab.length ? ` — allowed values: ${vocab.join(" | ")}` : ""}`;
            })
            .join("\n");
          return `  ${r.name} (${r.kind}):\n${sub}`;
        }),
      ]
    : [];

  const creds = credentialKeys.length
    ? `The operator has configured these credential fields (available at ctx.credentials.<name>; values are secret and not shown here): ${credentialKeys.map((k) => `\`${k}\``).join(", ")}.`
    : `No credentials are configured yet. If the source needs auth, read it from ctx.credentials.<name> and tell the operator which fields to set — do NOT hardcode secrets.`;

  return [
    `Write a data CONNECTOR as a single ESM JavaScript module. It must connect to the source the operator describes and return rows for the model ${targetKind} "${target.name}".`,
    ``,
    `## The source (operator's words)`,
    instructions || "(not specified yet — make a reasonable best effort and surface what you need via thrown errors / ctx.log)",
    ``,
    `## Target shape — your returned objects MUST be keyed by THESE field names`,
    fields || "  (no fields declared)",
    targetKind === "entity"
      ? `\nEach row should have a stable unique "id" (use the source's natural key; if there is none, derive a deterministic one).`
      : `\nThis is a value object (no identity of its own). Return the field values; the platform assigns an id when landing it as its own table.`,
    ...relatedSection,
    ``,
    `## How to reach the source — you have FULL power`,
    `You MAY import ANY npm package (e.g. @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, pg, mysql2, mongodb, googleapis, soap, ldapjs, snowflake-sdk) and use ANY protocol. Just \`import\` what you need with ESM syntax — the runtime detects your imports and installs them automatically before running. Plain HTTP/REST: use the global \`fetch\` (also available as ctx.fetch).`,
    ``,
    `## The ctx you are given`,
    `  ctx.credentials   — object with the operator's configured credential fields (see below)`,
    `  ctx.secret        — convenience: the first of secret/apiKey/token/key/password in ctx.credentials, if any`,
    `  ctx.endpoint      — ${endpoint ? JSON.stringify(endpoint) : "the configured endpoint string, or undefined"}`,
    `  ctx.entity        — the model ${targetKind} schema (fields/required/dataType)`,
    `  ctx.limit         — max rows to return`,
    `  ctx.fetch(url,init)— the global fetch`,
    `  ctx.log(message)  — append a line to the run trace shown to the operator (do NOT rely on console for diagnostics)`,
    ``,
    creds,
    ``,
    `## Export contract`,
    `  export async function fetchRows(ctx) { /* … */ }  // returns an array of plain objects keyed by the field names above, at most ctx.limit of them`,
    `  export async function probe(ctx) { return { ok: true, detail: "…" } }  // OPTIONAL: a cheap reachability check`,
    ``,
    `## Rules`,
    `- Coerce values to the target dataTypes (numbers as numbers, dates as ISO strings, booleans as booleans).`,
    `- If the operator asked to EMBED a related value object, return it as a nested object/array on that field — it will be stored as JSON.`,
    ...((related ?? []).length
      ? [`- FABRICATED data for a field with a Related schema must use ONLY that schema's allowed values (see "Related schemas") — distribute them realistically across rows, but never invent a value outside the list.`]
      : []),
    `- Authenticate ONLY from ctx.credentials. Never hardcode or ctx.log a secret.`,
    `- On any failure, throw an Error whose message explains what went wrong (it is shown to the operator and fed back to you to fix).`,
    `- Output ONLY the JavaScript module source. No markdown fences, no prose, no commentary.`,
    errorReport ? `\n## Your previous attempt FAILED — fix it\nError + trace (secrets redacted):\n${errorReport}` : ``,
  ].join("\n");
}

// --- Connector description (doc summary) ------------------------------------
// A second, read-only AI pass that documents a BUILT connector for the operator.
// It reads the generated code (so filters/sort/limits it actually contains are
// reported faithfully) plus the connector's metadata, and returns one short
// factual paragraph. Kept separate from generateConnectorModule so the
// code-gen contract (output ONLY the module) is never muddied.

interface ConnectorDescribeInput {
  /** System / bounded context the connector belongs to. */
  system: string;
  /** The model kind it populates. */
  target: EntitySchema;
  targetKind: "entity" | "valueObject";
  /** Operator's natural-language note on the source. */
  instructions: string;
  /** Credential FIELD NAMES configured (never values) — the access method. */
  credentialKeys: string[];
  /** Configured source endpoint, if any. */
  endpoint?: string;
  /** npm packages the module imports (hints at the protocol/driver). */
  deps: string[];
  /** Provenance mode (simulated | recorded | live). */
  mode?: string;
  /** The connector's current ESM source — the ground truth for filters/sort/limits. */
  code: string;
}

function buildDescribePrompt(input: ConnectorDescribeInput): string {
  const { system, target, targetKind, instructions, credentialKeys, endpoint, deps, mode, code } = input;
  return [
    `Document a data CONNECTOR for an operator. Write a short, factual description of what it does, grounded in the metadata AND the source code below.`,
    ``,
    `## Metadata`,
    `- System / bounded context: ${system}`,
    `- Target table: ${target.name} (${targetKind})`,
    `- Operator's note on the source: ${instructions || "(none given)"}`,
    `- Configured credential field names: ${credentialKeys.length ? credentialKeys.join(", ") : "(none)"}`,
    `- Configured endpoint: ${endpoint || "(none)"}`,
    `- npm packages imported: ${deps.length ? deps.join(", ") : "(none — likely plain HTTP/fetch)"}`,
    `- Data provenance mode: ${mode || "(unset)"}`,
    ``,
    `## Connector source code`,
    code ? code.slice(0, 8000) : "(no code authored yet)",
    ``,
    `## What to write`,
    `One short paragraph (1–3 sentences, plain text, no markdown, no preamble). State, where determinable from the code/metadata:`,
    `  1. The source SYSTEM it connects to — name it, and the protocol/driver if clear (e.g. DynamoDB via @aws-sdk, Postgres via pg, a REST API over fetch).`,
    `  2. The target TABLE it populates (${target.name}).`,
    `  3. How it AUTHENTICATES — i.e. which KIND of credentials it uses, inferred from the credential field names and the code (e.g. API key, bearer token, basic username/password, AWS access keys, OAuth). If it uses none, say it is unauthenticated.`,
    `  4. Any FILTERS, SORT ORDERS, or row LIMITS baked into the code — read the code carefully. If there are none beyond the caller-supplied limit, say so explicitly.`,
    `  5. Anything else notable: pagination, embedded/nested value objects, or important data-shape handling.`,
    `Describe only what the code and metadata actually show — do not invent. Output ONLY the description text.`,
  ].join("\n");
}

/** Key-gated: document a built connector. Returns one short factual paragraph.
 * Throws on no key / empty output so the caller can fall back deterministically. */
export async function describeConnector(input: ConnectorDescribeInput): Promise<string> {
  const { client, model } = await getAnthropicClient();
  const res = await client.messages.create({
    model,
    max_tokens: 512,
    system: "You write one short, factual paragraph documenting a data connector for an operator. Plain text only: no markdown, no preamble, no bullet points.",
    messages: [{ role: "user", content: buildDescribePrompt(input) }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("empty description from model");
  return text;
}

// --- Date-role inference (creation vs last-modified) ------------------------
// A connector populates a CURRENT-STATE snapshot row, which typically carries two
// real time anchors the source records: when the record was first CREATED and
// when it was LAST MODIFIED. Capturing WHICH model field is which lets
// twin/derive.ts stamp a create-kind event with the creation date and an
// update-kind event with the last-modified date — real anchors instead of
// ingestion-time `now`. The source system is where this is known, so we infer it
// at build time: a deterministic name/dataType heuristic first (covers
// created_at / updatedAt / lastModified …), with a small AI pass refining ONLY
// the ambiguous cases.

interface DateRoles {
  created?: string;
  updated?: string;
}

const CREATE_ROLE_RE = /(creat|register|signup|sign[_-]?up|opened|opening|started|placed|issued|added|received|submitted|requested|born|joined|enrol)/i;
const UPDATE_ROLE_RE = /(updat|modif|changed|edited|touched|synced|last[_-]?seen|last[_-]?login|last[_-]?activ|revis|amended)/i;

/** Is this field plausibly a timestamp? A date/time dataType, or a temporally
 * named column (…date/…time/…timestamp, created/updated/modified/registered, a
 * `_at`/`_on` suffix, or a camelCase `At`/`On` ending like `createdAt`). Tuned to
 * EXCLUDE non-temporal lookalikes ("creator", "flat", "person"). */
function isTimestampField(name: string, dataType?: string): boolean {
  if (/date|time/i.test(dataType ?? "")) return true;
  if (/(date|time|timestamp|created|updated|modified|registered)/i.test(name)) return true;
  if (/_(at|on)\b/i.test(name)) return true;
  if (/[a-z](At|On)\b/.test(name)) return true;
  return false;
}

// gen_ projection tables ALWAYS carry these platform timestamp columns, and a
// connector commonly maps the source's creation / last-modified times straight
// INTO them (the returned values override the ingestion-time defaults on insert —
// see projection-store.insert). They are therefore valid date anchors even when
// the model declares no date-typed BUSINESS field — which is the common case (an
// Account with email/status/… but no `registeredAt`, its real Cognito
// UserCreateDate/UserLastModifiedDate sitting in createdAt/updatedAt).
export const PLATFORM_TIMESTAMP_COLS = ["createdAt", "updatedAt"];

/** The target's candidate timestamp columns (model field names), in declared
 * order, PLUS the always-present platform `createdAt`/`updatedAt`. Business date
 * fields come first so a declared date field wins the heuristic over a platform
 * column. */
export function timestampFields(target: EntitySchema): string[] {
  const out = target.fields
    .filter((f) => f.name !== "id" && isTimestampField(f.name, f.dataType))
    .map((f) => f.name);
  for (const c of PLATFORM_TIMESTAMP_COLS) if (!out.includes(c)) out.push(c);
  return out;
}

/** Deterministic created/updated guess from the timestamp fields' names alone.
 * Pure (unit-testable). The first creation-ish name wins `created`, the first
 * modification-ish name wins `updated`. */
export function inferDateRoles(target: EntitySchema): DateRoles {
  const out: DateRoles = {};
  for (const name of timestampFields(target)) {
    if (!out.created && CREATE_ROLE_RE.test(name)) out.created = name;
    else if (!out.updated && UPDATE_ROLE_RE.test(name)) out.updated = name;
  }
  return out;
}

interface DateRolesInput {
  target: EntitySchema;
  /** The operator's natural-language note on the source (disambiguates roles). */
  instructions: string;
  /** The connector's generated source — shows how each column is actually read. */
  code: string;
}

/** Keep only a name the target schema actually declares (a hallucinated or
 * stale column can't silently become a date anchor). */
function validRole(name: string | undefined, candidates: string[]): string | undefined {
  return name && candidates.includes(name) ? name : undefined;
}

/** Key-gated AI refinement: choose the creation + last-modified columns from the
 * candidate timestamp fields. Best-effort — returns {} on no key, a parse failure,
 * or any error, so the caller keeps the heuristic. Never throws. */
async function classifyDateRolesAI(input: DateRolesInput, candidates: string[]): Promise<DateRoles> {
  const prompt = [
    `A data connector populates the table "${input.target.name}". Some of its columns may be timestamps the SOURCE records: when the record was first CREATED, and when it was LAST MODIFIED.`,
    ``,
    `Candidate timestamp columns: ${candidates.join(", ")}.`,
    input.instructions ? `\nOperator's note on the source: ${input.instructions}` : ``,
    input.code ? `\nConnector source (how the columns are read):\n${input.code.slice(0, 4000)}` : ``,
    ``,
    `Decide which column is the CREATION timestamp and which is the LAST-MODIFIED timestamp. A column may be neither. Choose ONLY from the candidate list above, or null if none fits.`,
    `Respond with ONLY a JSON object, no prose: {"created": "<column or null>", "updated": "<column or null>"}.`,
  ].join("\n");
  try {
    // Best-effort: a missing key (no org key + no platform default) makes the
    // resolver throw, which the catch turns into {} so the heuristic stands.
    const { client, model } = await getAnthropicClient();
    const res = await client.messages.create({
      model,
      max_tokens: 128,
      system: "You classify timestamp columns for a data connector. Output only a single JSON object.",
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return {};
    const parsed = JSON.parse(m[0]) as { created?: unknown; updated?: unknown };
    return {
      created: typeof parsed.created === "string" ? parsed.created : undefined,
      updated: typeof parsed.updated === "string" ? parsed.updated : undefined,
    };
  } catch {
    return {};
  }
}

/** Propose created/updated date roles for a freshly built connector: the
 * deterministic heuristic, refined by a small AI pass ONLY when the heuristic
 * leaves a gap AND there are still unclassified candidate columns (so the common
 * created_at/updated_at case costs no extra call). Best-effort and
 * side-effect-free; the caller persists the result on the sidecar. */
export async function proposeDateRoles(input: DateRolesInput): Promise<DateRoles> {
  const candidates = timestampFields(input.target);
  const heur = inferDateRoles(input.target);
  const resolvedBoth = !!heur.created && !!heur.updated;
  const allClassified = candidates.every((c) => c === heur.created || c === heur.updated);
  if (candidates.length === 0 || resolvedBoth || allClassified) return heur;
  const ai = await classifyDateRolesAI(input, candidates);
  return {
    created: validRole(ai.created, candidates) ?? heur.created,
    updated: validRole(ai.updated, candidates) ?? heur.updated,
  };
}

/** Key-gated: author (or repair) a connector module. Returns the ESM source and
 * the npm packages it imports. No file I/O here — the caller persists. */
export async function generateConnectorModule(input: ConnectorGenInput): Promise<ConnectorGenResult> {
  const prompt = buildConnectorPrompt(input);
  const { client, model } = await getAnthropicClient();
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    system: "You write a single ESM JavaScript module — a data connector. Output only the module source: no markdown fences, no prose.",
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const code = text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/m, "").trim();
  return { code, deps: scanImports(code) };
}
