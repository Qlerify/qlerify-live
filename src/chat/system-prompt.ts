// Builds the cached system prompt that frames every chat turn.
//
// Layout:
//   Block 1 — role + behavior + tool-usage policy (small, stable)
//   Block 2 — full Qlerify workflow dump (large, stable, cache_control here)
//
// Caching is a prefix match (see shared/prompt-caching.md). Both blocks are
// deterministic — no timestamps, no per-session content — so the entire
// prefix hits cache from request #2 onward.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STEP_DURATIONS_HOURS } from "../events/clock.js";
import { EVENTS } from "../events/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, "..", "..", ".qlerify", "workflow.json");

interface WorkflowDoc {
  domainEvents: Record<string, {
    event: string;
    role: string;
    follows: string[];
    aggregateRoot?: { $ref: string };
    command?: { $ref: string };
    acceptanceCriteria?: string[];
  }>;
  schemas: {
    entities: Record<string, { description?: string; boundedContext?: string; required?: string[]; fields: Array<{ name: string; description?: string; dataType?: string }> }>;
    commands: Record<string, { description?: string; fields?: Array<{ name: string }> }>;
    queries: Record<string, { description?: string }>;
  };
}

const workflow = JSON.parse(readFileSync(workflowPath, "utf-8")) as WorkflowDoc;

// ---------------------------------------------------------------------------
// Build the workflow dump section
// ---------------------------------------------------------------------------

function refToName(ref: string): string {
  return ref.replace(/^#\/[^/]+\/[^/]+\//, "");
}

function eventsSection(): string {
  const lines: string[] = ["## The 28-event workflow (chronological)"];
  for (let i = 0; i < EVENTS.length; i++) {
    const e = EVENTS[i]!;
    const spec = workflow.domainEvents[refToName(e.ref)];
    const dur = STEP_DURATIONS_HOURS[i] ?? 0;
    const durLabel = dur === 0 ? "instant (derived)" : dur < 48 ? `${dur}h` : `${Math.round(dur / 24)}d`;
    const aggRef = spec?.aggregateRoot?.$ref ? refToName(spec.aggregateRoot.$ref) : "?";
    const cmdRef = spec?.command?.$ref ? refToName(spec.command.$ref) : "?";
    const gwts = (spec?.acceptanceCriteria ?? []).map((g) => `      - ${g}`).join("\n");
    lines.push(
      `Step ${i + 1}. **${e.name}** (${e.boundedContext} · ${e.role}${e.derived ? " · DERIVED" : ""})`,
      `    duration from prev: ${durLabel}`,
      `    aggregate root: ${aggRef}`,
      `    command: ${cmdRef}`,
      gwts ? `    acceptance criteria:\n${gwts}` : "    acceptance criteria: (none recorded)",
    );
  }
  return lines.join("\n");
}

function entitiesSection(): string {
  const lines: string[] = ["## Entities (16)"];
  for (const [name, e] of Object.entries(workflow.schemas.entities)) {
    const bc = e.boundedContext ?? "Unassigned";
    const required = (e.required ?? []).join(", ");
    const fields = e.fields.map((f) => f.name).join(", ");
    lines.push(`- **${name}** (${bc}) — ${e.description ?? ""}`);
    if (fields) lines.push(`    fields: ${fields}`);
    if (required) lines.push(`    required: ${required}`);
  }
  return lines.join("\n");
}

function commandsSection(): string {
  const lines: string[] = ["## Commands (28)"];
  for (const [name, c] of Object.entries(workflow.schemas.commands)) {
    const args = (c.fields ?? []).map((f) => f.name).join(", ");
    lines.push(`- **${name}**${c.description ? ` — ${c.description}` : ""}${args ? ` · args: ${args}` : ""}`);
  }
  return lines.join("\n");
}

function queriesSection(): string {
  const lines: string[] = ["## Read models / queries (25)"];
  for (const [name, q] of Object.entries(workflow.schemas.queries)) {
    lines.push(`- **${name}**${q.description ? ` — ${q.description}` : ""}`);
  }
  return lines.join("\n");
}

function durationsSection(): string {
  // Total business duration spanned by the workflow — useful when the user
  // asks "how long does the whole process take?".
  const totalHours = STEP_DURATIONS_HOURS.reduce((a, b) => a + b, 0);
  const totalDays = Math.round(totalHours / 24);
  return [
    "## Business clock",
    `Each event's recorded \`occurredAt\` is *real wall-clock time* (when the simulator fired it). Each event also carries a \`businessAt\` — a *simulated* date derived from the per-step durations above, anchored at SIM_BASE = 2026-04-01T08:00 UTC.`,
    `Total simulated duration from Hardware Demand Created to Unit Received By Customer is ~${totalHours} hours (~${totalDays} days, ~${Math.round(totalDays/7)} weeks).`,
    `When the user asks "how long has this been stuck" or "is anything older than a week", reason in *real-time dwell* (\`dwellSeconds\` on each demand) since the simulator compresses ~9 weeks of business time into seconds of wall-clock. A "week" in demo context is anything stalled longer than the user expects to wait between clicks — usually a few minutes.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Behavior section — the smaller stable preamble
// ---------------------------------------------------------------------------

const BEHAVIOR = `You are the **process assistant** for the Ericsson HW Flow demo simulator. The simulator runs the 28-event workflow that takes a customer hardware demand from creation through delivery, across 7 systems (Helix, PRIM, SAP, ESTER, Compass, Test, Logistics).

Your job: help the user understand and act on the state of demands currently in flight. You can:
- Answer status questions ("how many demands are stalled", "what's the next step for demand X")
- Look up specific demands by description, customer, product, or id
- Explain the workflow ("what does Build Plan Locked do", "what gates Material Kit Completed")
- Move demands forward (one step at a time, or all the way) — **but only with explicit user confirmation** (see below)
- Create new demands — also requires confirmation

## Tool-use policy

- Always look up current state before answering ("list_demands", "get_demand_details", "get_event_log"). Don't guess from prior turns — demands change between turns.
- Prefer the most specific query. \`find_demand\` is for fuzzy text matches; \`get_demand_details\` is for full state.
- \`get_workflow_step\` returns the canonical name, role, GWTs, and expected duration for any step 1–28. Use it to explain "what happens next" or "what gates this".

## Write-tool confirmation (mandatory)

Two tools mutate state: \`next_step\` and \`create_demand\`. Both take a required \`confirmed: boolean\` parameter.

**Before calling either with \`confirmed: true\`:**
1. Summarize the action in one sentence. ("I'll advance demand dmd-xyz (Radio Unit X, cust-10) from step 5 to step 6: Material Demand Specified.")
2. Ask the user to confirm: "Shall I proceed?" or "Confirm?"
3. Wait for an explicit affirmative response ("yes", "yep", "go ahead", "do it", "confirm", "proceed"). A vague "ok" or "sure" counts. A question or hesitation ("what would that do?", "wait") does not.
4. Only then call the tool with \`confirmed: true\`.

If the user denies or asks for clarification, do not call the tool. If you call a write tool with \`confirmed: false\`, the tool will refuse — that's a safety net, not a workflow.

## UI context

The user is interacting through a dashboard + per-demand detail page. When they have a specific demand open, their messages will be prefixed with a \`[Context: viewing demand <id> — <description>. ...]\` block. **Treat this as authoritative**: when the user says "this demand", "it", "the next step", or refers to a step without naming a demand, they mean the one in the context block. You do not need to ask which demand they mean — look it up directly.

If a message has no context block, the user is on the dashboard (or asking generally); ask for clarification only when the question genuinely depends on a specific demand.

## Response style

Concise. Lead with the answer; expand only if asked. Use tables for lists of more than 3 items. When citing a demand, include both the short id (first 12 chars) and a human description (qty × product for customer).`;

// ---------------------------------------------------------------------------
// Public export — two system blocks, cache_control on the last.
// ---------------------------------------------------------------------------

const WORKFLOW_DUMP = [
  "# Qlerify workflow definition",
  "Below is the canonical workflow this simulator is generated from. Treat it as the source of truth for what each step means.",
  "",
  eventsSection(),
  "",
  durationsSection(),
  "",
  entitiesSection(),
  "",
  commandsSection(),
  "",
  queriesSection(),
].join("\n");

export const SYSTEM_BLOCKS = [
  { type: "text" as const, text: BEHAVIOR },
  { type: "text" as const, text: WORKFLOW_DUMP, cache_control: { type: "ephemeral" as const } },
];

// Exported for diagnostics — `npm run dev` can print this at boot to verify size.
export function systemPromptSize() {
  const total = BEHAVIOR.length + WORKFLOW_DUMP.length;
  return { behaviorChars: BEHAVIOR.length, workflowChars: WORKFLOW_DUMP.length, totalChars: total };
}
