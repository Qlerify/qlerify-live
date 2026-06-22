// AI author for full-power connectors (Part 2.4). Builds a prompt from the target
// kind (entity OR value object) schema + the user's natural-language description of
// the source + the credential field names that are configured, calls Claude, and
// returns the ESM module source plus the npm packages it imports (so the runtime
// can install them). buildConnectorPrompt has no side effects (unit-testable);
// only generateConnectorModule calls out.

import Anthropic from "@anthropic-ai/sdk";
import type { EntitySchema } from "../../ontology/model.js";
import { scanImports } from "./runtime.js";

const MODEL = process.env.CHAT_MODEL ?? "claude-sonnet-4-6";

export interface ConnectorGenInput {
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
}

export interface ConnectorGenResult {
  code: string;
  deps: string[];
}

export function buildConnectorPrompt(input: ConnectorGenInput): string {
  const { target, targetKind, instructions, credentialKeys, endpoint, errorReport } = input;
  const fields = target.fields
    .map((f) => {
      const req = (target.required ?? []).includes(f.name) ? " (required)" : "";
      const ex = f.exampleData?.[0] !== undefined ? ` — e.g. ${JSON.stringify(f.exampleData[0])}` : "";
      const rel = f.relatedEntity ? ` [holds a ${f.relatedEntity}${f.array ? "[]" : ""} value object]` : "";
      return `  ${f.name}: ${f.dataType ?? "string"}${req}${ex}${rel}`;
    })
    .join("\n");

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
    `- Authenticate ONLY from ctx.credentials. Never hardcode or ctx.log a secret.`,
    `- On any failure, throw an Error whose message explains what went wrong (it is shown to the operator and fed back to you to fix).`,
    `- Output ONLY the JavaScript module source. No markdown fences, no prose, no commentary.`,
    errorReport ? `\n## Your previous attempt FAILED — fix it\nError + trace (secrets redacted):\n${errorReport}` : ``,
  ].join("\n");
}

/** Key-gated: author (or repair) a connector module. Returns the ESM source and
 * the npm packages it imports. No file I/O here — the caller persists. */
export async function generateConnectorModule(input: ConnectorGenInput): Promise<ConnectorGenResult> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set — cannot author a connector");
  const prompt = buildConnectorPrompt(input);
  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
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
