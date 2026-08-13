// AI compiler for per-event trigger rules. The AI is a COMPILER here, not a
// runtime: it turns the event's GWT acceptance criteria + the operator's
// natural-language condition into a tiny deterministic predicate module once,
// at build time — derive then runs plain code per row, with zero LLM calls.
// buildRulePrompt is pure (unit-testable); only generateRuleModule calls out;
// compileTriggerRule is the orchestration the chat tool / recompile route use,
// ending in rules.ts's saveTriggerRuleCode (the single deny-scanned write path).

import Anthropic from "@anthropic-ai/sdk";
import { getOntology, type EntitySchema } from "../../ontology/model.js";
import { getAnthropicClient, friendlyLlmError } from "../../llm/anthropic.js";
import * as store from "../../twin/projection-store.js";
import { NotFoundError } from "../../errors.js";
import { readSidecar } from "../sidecar.js";
import { eventsForTarget } from "./orchestrate.js";
import {
  assertRuleBindable, resolveRuleEvent, saveTriggerRuleCode, type SaveTriggerRuleResult,
} from "./rules.js";
import { SNAPSHOT_ROWS_PER_TABLE } from "./runtime.js";
import type { TriggerRule } from "../types.js";

export interface RuleGenInput {
  event: { key: string; name: string; ref: string; commandName: string; acceptanceCriteria: string[] };
  /** Sibling events sharing the command — alternative outcomes of one decision.
   * Their conditions (when already ruled) sharpen the boundary between outcomes. */
  siblings: Array<{ key: string; name: string; condition?: string }>;
  /** The operator's natural-language condition ("upsell deals over 20 000 USD in
   * the current quarter"). May be empty — then the GWTs alone are the spec. */
  condition: string;
  target: EntitySchema;
  /** Up to 5 real rows from the target table — the value shapes the predicate
   * must coerce (numbers as strings, booleans as 0/1, …). */
  sampleRows?: Array<Record<string, unknown>>;
  workflowTables: string[];
  /** On a self-heal turn: the error / wrong-preview report from the last attempt. */
  errorReport?: string;
}

/** Exported for unit tests — pure (no I/O, no ontology reads). */
export function buildRulePrompt(input: RuleGenInput): string {
  const { event, siblings, condition, target, sampleRows, workflowTables, errorReport } = input;
  const fields = target.fields
    .map((f) => `  ${f.name}: ${f.dataType ?? "string"}${(target.required ?? []).includes(f.name) ? " (required)" : ""}`)
    .join("\n");
  const samples = (sampleRows ?? []).slice(0, 5).map((r) => `  ${JSON.stringify(r)}`).join("\n");
  return [
    `Write the TRIGGER RULE for the domain event "${event.name}" as a single ESM JavaScript module. The platform calls it once per ${target.name} row to decide whether that row's state implies this event happened.`,
    ``,
    `## The event`,
    `- Name: ${event.name} (key ${event.key}, command ${event.commandName})`,
    ...(event.acceptanceCriteria.length
      ? [`- Given/When/Then acceptance criteria (the source of truth for the logic):`, ...event.acceptanceCriteria.map((g) => `    - ${g}`)]
      : [`- (no acceptance criteria recorded on the event)`]),
    ...(condition ? [``, `## The operator's condition (authoritative where more specific than the criteria)`, condition] : []),
    ...(siblings.length
      ? [
          ``,
          `## Alternative outcomes sharing this decision step`,
          `These sibling events are the OTHER outcomes of command ${event.commandName} — a row that satisfies one of THEIR conditions must NOT fire this rule:`,
          ...siblings.map((s) => `  - ${s.name}${s.condition ? ` — fires when: ${s.condition}` : ""}`),
        ]
      : []),
    ``,
    `## The row shape (${target.name})`,
    fields || "  (no fields declared)",
    ...(samples ? [``, `## Real rows right now (coerce like these actually look — numbers may arrive as strings, booleans as 0/1/"true")`, samples] : []),
    ``,
    `## The contract`,
    `  export function detect(row, ctx, previous) { return { fired, evidence }; }`,
    `- SYNCHRONOUS and PURE: no async/await, no Promises, no imports of any kind, no fetch/network, no fs, no process, no Date.now() side-channels — time comes ONLY from ctx.now.`,
    `- \`previous\` is reserved (always null today) — ignore it, but keep the parameter.`,
    `- Return { fired: boolean, evidence: string }. evidence must cite the DECIDING values (e.g. "amount=25000 (>20000), category=\\"upsell\\"") — it is shown to the operator per row.`,
    `- Coerce defensively: Number(row.x), String(row.x), and treat null/undefined/"" as ABSENT. An absent value is never evidence — when a field the condition needs is absent, return fired:false and say which field was missing in evidence.`,
    ``,
    `## ctx`,
    `  ctx.now                      — a Date, fixed for the whole pass ("today")`,
    `  ctx.period.of(date, g)      — the canonical period key for a date; g is "quarter" | "month" | "week" | "year" (e.g. of(ctx.now, "quarter") → "2026Q3"). "Current quarter" means: ctx.period.of(rowDate, "quarter") === ctx.period.of(ctx.now, "quarter").`,
    `  ctx.period.start(period, g) — that period's first instant as a Date`,
    `  ctx.readTable(name)         — read-only snapshot of another workflow table (array of rows; capped at ${SNAPSHOT_ROWS_PER_TABLE}, may be incomplete — never assume it holds everything). The snapshot is taken at the START of the derive pass, so rows the SAME pass creates (e.g. a period's cycle row opened lazily when its first child is processed) are NOT visible yet — do not depend on same-pass sibling rows appearing here${workflowTables.length ? `. Tables: ${workflowTables.join(", ")}` : ""}`,
    `  ctx.log(msg)                — a bounded diagnostic trace shown in previews`,
    `  ctx.event, ctx.entity       — this event's and table's model metadata`,
    ``,
    `## Rules`,
    `- Decide from the ROW's state (plus ctx.readTable lookups when the condition spans tables). Do not re-implement the platform's create/status heuristics — express EXACTLY the condition above.`,
    `- Deterministic: same row + same ctx.now ⇒ same answer.`,
    `- Output ONLY the JavaScript module source. No markdown fences, no prose, no commentary.`,
    errorReport ? `\n## Your previous attempt was WRONG — fix it\n${errorReport}` : ``,
  ].join("\n");
}

function stripFences(text: string): string {
  return text.replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

/** Key-gated: compile one rule module from the prompt above. A raw provider
 * failure is wrapped as LlmError (never surfaced to the user verbatim — the HTTP
 * recompile route sends handled errors cleanly, the chat tool reports the message
 * in its failures list). */
export async function generateRuleModule(input: RuleGenInput): Promise<{ code: string }> {
  const { client, model, provider } = await getAnthropicClient();
  let res: Anthropic.Message;
  try {
    res = await client.messages.create({
      model,
      max_tokens: 1500,
      system:
        "You compile natural-language event-trigger conditions into tiny deterministic JavaScript predicate modules. Output only the module source — no markdown fences, no explanations.",
      messages: [{ role: "user", content: buildRulePrompt(input) }],
    });
  } catch (e) {
    throw friendlyLlmError(e, provider) ?? e;
  }
  const code = stripFences(
    res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(""),
  );
  if (!code) throw new Error("empty rule module from model");
  return { code };
}

export interface CompileTriggerRuleResult extends SaveTriggerRuleResult {
  bytes: number;
  durationMs: number;
}

/**
 * Compile (or re-compile / self-heal) one event's trigger rule for a connector:
 * resolve the event, gather the grounding (GWTs, sibling conditions, real sample
 * rows), call the compiler, and persist through saveTriggerRuleCode — the single
 * deny-scanned write path, which also stamps the CURRENT gwtHash (so a recompile
 * clears staleness). `condition` falls back to the stored one (a recompile keeps
 * the operator's intent); `errorReport` makes it a self-heal turn.
 */
export async function compileTriggerRule(
  id: string,
  eventKeyOrName: string,
  condition?: string,
  errorReport?: string,
): Promise<CompileTriggerRuleResult> {
  const t0 = Date.now();
  const cfg = readSidecar(id);
  if (!cfg) throw new NotFoundError(`no connector "${id}"`);
  const ont = getOntology();
  const event = resolveRuleEvent(ont, eventKeyOrName);
  if (!event) throw new NotFoundError(`no event "${eventKeyOrName}" in the loaded model`);
  // Fail BEFORE the LLM call on an unbindable event (wrong table, satellite, VO).
  assertRuleBindable(cfg, event);
  const target = ont.entity(cfg.targetEntity)!;
  const stored = (cfg.triggerRules ?? []).find((r) => r.eventKey === event.key);
  const cond = (condition ?? stored?.condition ?? "").trim();
  const ruleByKey = new Map((cfg.triggerRules ?? []).map((r) => [r.eventKey, r] as [string, TriggerRule]));
  const siblings = eventsForTarget(target.name)
    .filter((e) => e.key !== event.key && e.commandName === event.commandName)
    .map((e) => ({
      key: e.key,
      name: e.name,
      ...(ruleByKey.get(e.key)?.condition ? { condition: ruleByKey.get(e.key)!.condition } : {}),
    }));
  const sampleRows = (await store.tableExists(target.name)) ? await store.findMany(target.name, 5) : [];
  const { code } = await generateRuleModule({
    event: { key: event.key, name: event.name, ref: event.ref, commandName: event.commandName, acceptanceCriteria: event.acceptanceCriteria },
    siblings,
    condition: cond,
    target,
    ...(sampleRows.length ? { sampleRows } : {}),
    workflowTables: [...ont.entities, ...ont.valueObjects].map((e) => e.name),
    ...(errorReport ? { errorReport } : {}),
  });
  const saved = saveTriggerRuleCode(id, event.key, code, { author: "ai", ...(cond ? { condition: cond } : {}) });
  return { ...saved, bytes: code.length, durationMs: Date.now() - t0 };
}
