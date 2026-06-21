// AI author for adapter BODIES (Part 2.3, Slice 2). Mirrors kernel/codegen/ai.ts:
// builds a prompt from the model entity + the connection config, calls the
// Anthropic client, fence-strips, deny-scans, and writes the body to a UNIQUE
// content-hash path (Fix 1 — tsx ignores `?v=mtime`, so a new path is how the
// host sees fresh code). buildAdapterPrompt + writeBody have no side effects and
// need no API key (so they're unit-testable); only generateAdapterBody calls out.

import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getOntology, type EntitySchema } from "../../ontology/model.js";
import type { AdapterConfig } from "../types.js";
import { denyScan } from "./deny-scan.js";

const MODEL = process.env.CHAT_MODEL ?? "claude-sonnet-4-6";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function buildAdapterPrompt(cfg: AdapterConfig, entity: EntitySchema): string {
  const fields = entity.fields
    .map((f) => `  ${f.name}: ${f.dataType ?? "string"}${entity.required.includes(f.name) ? " (required)" : ""}${f.exampleData?.[0] !== undefined ? ` — e.g. ${JSON.stringify(f.exampleData[0])}` : ""}`)
    .join("\n");
  return [
    `Write the BODY of a source-system adapter for the "${cfg.boundedContext}" bounded context.`,
    `It must fetch records from the source system and return them as rows for the model entity "${entity.name}".`,
    ``,
    `Target entity "${entity.name}" fields (your returned objects must use THESE field names):`,
    fields,
    ``,
    `Connection:`,
    `- endpoint: ${cfg.endpoint ? JSON.stringify(cfg.endpoint) : "(none configured — read it from ctx.endpoint, may be undefined)"}`,
    cfg.credentialsRef
      ? `- auth: a secret is available as ctx.secret (resolved from credential key "${cfg.credentialsRef}"). Use it for the auth header. NEVER hardcode or log it.`
      : `- auth: none configured (ctx.secret may be undefined).`,
    ``,
    `Export exactly:`,
    `  export async function fetchRows(ctx) { ... }  // returns an array of plain objects keyed by the entity field names above, at most ctx.limit of them`,
    `  // optional: export async function probe(ctx) { return { ok: boolean, detail?: string } }`,
    ``,
    `The ctx you are given (use ONLY these — there is no other ambient API):`,
    `  ctx.fetch(url, init)  — like fetch(), but with a timeout, size cap, and secret redaction`,
    `  ctx.secret            — the resolved secret string (or undefined)`,
    `  ctx.endpoint          — the configured endpoint string (or undefined)`,
    `  ctx.entity            — the model entity schema (fields/required/dataType)`,
    `  ctx.limit             — max rows to return`,
    `  ctx.log(message)      — append a line to the run trace (do NOT use console)`,
    ``,
    `HARD RULES: do NOT import or use child_process, fs, net, vm, worker_threads, process.env, require(), eval, or new Function(). Reach the network ONLY via ctx.fetch and authenticate ONLY via ctx.secret. Coerce values to the entity's dataTypes. If the endpoint is unreachable, throw an Error (its message is shown to the operator).`,
    `Output ONLY the TypeScript module contents — no markdown fences, no prose.`,
  ].join("\n");
}

/** Repo-relative dir for a BC's generated bodies (gitignored). The BC name is
 * sanitized so contexts like "Identity & Access" yield a safe path. */
function bodyDir(cfg: AdapterConfig): string {
  const bcDir = cfg.boundedContext.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bc";
  return join("src", "packs", bcDir, "generated");
}

export interface WriteBodyResult {
  bodyPath: string; // repo-relative
  hash: string;
  skipped: boolean; // identical content already on disk
}

/** Fix 1: write the body to a UNIQUE content-hash path and return it. Idempotent
 * (same content → same path → skip). Deny-scans before writing. */
export function writeBody(cfg: AdapterConfig, code: string): WriteBodyResult {
  const clean = code.endsWith("\n") ? code : code + "\n";
  const scan = denyScan(clean);
  if (!scan.ok) throw new Error(`generated body rejected by deny-scan: ${scan.violations.join(", ")}`);
  const hash = sha256(clean).slice(0, 12);
  const rel = join(bodyDir(cfg), `${cfg.id}.${hash}.logic.ts`);
  const abs = join(ROOT, rel);
  const skipped = existsSync(abs);
  if (!skipped) {
    mkdirSync(join(ROOT, bodyDir(cfg)), { recursive: true });
    writeFileSync(abs, clean);
  }
  return { bodyPath: rel, hash, skipped };
}

/** Delete every generated body file for an adapter (all content-hash versions).
 * Used by reset/remove. Returns the count deleted. */
export function deleteGeneratedBodies(cfg: AdapterConfig): number {
  const dir = join(ROOT, bodyDir(cfg));
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(cfg.id + ".") && f.endsWith(".logic.ts")) {
      rmSync(join(dir, f));
      n++;
    }
  }
  return n;
}

export interface GenerateResult extends WriteBodyResult {
  bodyPromptHash: string;
}

/** Key-gated: generate (or repair) an adapter body from the model + config. The
 * optional errorReport is woven in for the self-heal/troubleshoot turn. */
export async function generateAdapterBody(cfg: AdapterConfig, errorReport?: string): Promise<GenerateResult> {
  const entity = getOntology().entity(cfg.targetEntity);
  if (!entity) throw new Error(`entity "${cfg.targetEntity}" not in the loaded model`);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set — cannot author an adapter body");

  const prompt = buildAdapterPrompt(cfg, entity) + (errorReport ? `\n\nThe previous body failed. Fix it. Error + trace (secrets redacted):\n${errorReport}` : "");
  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: "You write a single TypeScript module (an adapter body). Output only code, no markdown fences, no prose.",
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const code = text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/m, "").trim();
  const written = writeBody(cfg, code);
  return { ...written, bodyPromptHash: sha256(prompt) };
}
