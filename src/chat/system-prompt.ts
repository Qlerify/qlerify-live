// Builds the cached system prompt that frames every chat turn.
//
// Layout:
//   Block 1 — role + behavior + tool-usage policy (small, stable)
//   Block 2 — full Qlerify workflow dump (large, stable, cache_control here)
//
// Caching is a prefix match (see shared/prompt-caching.md). Both blocks are
// deterministic — no timestamps, no per-session content — so the entire
// prefix hits cache from request #2 onward.

import { EVENTS } from "../events/registry.js";
import { getOntology, onOntologyReload } from "../ontology/model.js";

// ---------------------------------------------------------------------------
// Build the workflow dump section — derived from the merged ontology, so it
// spans every bounded context (not just the primary one in the raw export).
// ---------------------------------------------------------------------------

function eventsSection(): string {
  const o = getOntology();
  const lines: string[] = [`## The ${EVENTS.length}-event workflow (chronological)`];
  for (let i = 0; i < EVENTS.length; i++) {
    const e = EVENTS[i]!;
    const spec = o.requireEventByRef(e.ref);
    const gwts = (spec.acceptanceCriteria ?? []).map((g) => `      - ${g}`).join("\n");
    lines.push(
      `Step ${i + 1}. **${spec.name}** (${spec.boundedContext} · ${spec.role}${e.derived ? " · DERIVED" : ""})`,
      `    aggregate root: ${spec.aggregateRoot || "?"}`,
      `    command: ${spec.commandName || "?"}`,
      gwts ? `    acceptance criteria:\n${gwts}` : "    acceptance criteria: (none recorded)",
    );
  }
  return lines.join("\n");
}

function entitiesSection(): string {
  const o = getOntology();
  const lines: string[] = [`## Entities (${o.entities.length})`];
  for (const e of o.entities) {
    const bc = o.boundedContextOf(e.name) ?? "—";
    const required = (e.required ?? []).join(", ");
    const fields = e.fields.map((f) => f.name).join(", ");
    lines.push(`- **${e.name}** (${bc}) — ${e.description ?? ""}`);
    if (fields) lines.push(`    fields: ${fields}`);
    if (required) lines.push(`    required: ${required}`);
  }
  return lines.join("\n");
}

function commandsSection(): string {
  const o = getOntology();
  const lines: string[] = [`## Commands (${o.commands.length})`];
  for (const c of o.commands) {
    const args = c.fields.map((f) => f.name).join(", ");
    lines.push(`- **${c.name}**${args ? ` · args: ${args}` : ""}`);
  }
  return lines.join("\n");
}

function queriesSection(): string {
  const o = getOntology();
  const lines: string[] = [`## Read models / queries (${o.queries.length})`];
  for (const q of o.queries) {
    const desc = typeof q.description === "string" ? q.description : "";
    lines.push(`- **${q.name}**${desc ? ` — ${desc}` : ""}`);
  }
  return lines.join("\n");
}

function durationsSection(): string {
  return [
    "## Business clock",
    "Each event carries two timestamps: `occurredAt` (real wall-clock — when the simulator recorded the row) and `businessAt` (the event's business date, taken from a date attribute in the event's own data). Reason about how long a step took as the difference between consecutive events' `businessAt` dates.",
    "The simulator fires events seconds apart in real time, so for \"how long has this been stuck\" / \"is anything stalled\" questions reason in *real-time dwell* (`dwellSeconds` on each instance), not business time. A \"week\" in demo terms is anything stalled longer than the user expects to wait between clicks — usually a few minutes.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Behavior section — the smaller stable preamble
// ---------------------------------------------------------------------------

function behaviorSection(): string {
  const o = getOntology();
  const root = o.rootAggregate;
  const contexts = o.boundedContexts.join(", ");
  return `You are the **process assistant** for a model-driven workflow simulator. The loaded model is **${o.title}** — a ${EVENTS.length}-step workflow across ${o.boundedContexts.length} bounded context(s) (${contexts}). Each run carries one ${root} instance from creation through completion.

Your job: help the user understand and act on the state of the instances currently in flight. You can:
- Answer status questions ("how many are stalled", "what's the next step for instance X")
- Look up specific instances by description or id
- Explain the workflow ("what does step N do", "what gates event Y")
- Move instances forward (one step at a time, or all the way) — **but only with explicit user confirmation** (see below)
- Create new instances — also requires confirmation

## Tool-use policy

- Always look up current state before answering (\`list_demands\`, \`get_demand_details\`, \`get_event_log\`). Don't guess from prior turns — state changes between turns.
- Prefer the most specific query. \`find_demand\` is for fuzzy text matches; \`get_demand_details\` is for full state.
- \`get_workflow_step\` returns the canonical name, role, command, and acceptance criteria for any step. Use it to explain "what happens next" or "what gates this".

## Write-tool confirmation (mandatory)

Four tools mutate state: \`next_step\`, \`create_demand\`, \`regenerate_adapter_body\`, and \`reset_adapter\`. Each takes a required \`confirmed: boolean\` parameter.

**Before calling one with \`confirmed: true\`:**
1. Summarize the action in one sentence (which instance, from which step to which next event).
2. Ask the user to confirm: "Shall I proceed?" or "Confirm?"
3. Wait for an explicit affirmative response ("yes", "yep", "go ahead", "do it", "confirm", "proceed"). A vague "ok" or "sure" counts. A question or hesitation ("what would that do?", "wait") does not.
4. Only then call the tool with \`confirmed: true\`.

If the user denies or asks for clarification, do not call the tool. If you call a write tool with \`confirmed: false\`, the tool will refuse — that's a safety net, not a workflow.

## Adapter Connection Doctor

Each bounded context can have a source adapter that pulls real data into the model. When an adapter fails to connect or returns the wrong shape, help the user diagnose and repair it.

Diagnosis tools (all read-only, safe to call freely): \`list_adapters\` (find the adapter), \`get_adapter_config\` (how it's wired — endpoint, credential KEY, whether a body exists; never the secret), \`check_adapter_credential\` (is the secret present — a boolean only), \`run_adapter_healthcheck\` (is it reachable now), \`adapter_dry_run\` (pull a few rows without writing — returns a sample, missing required fields, or the thrown error + redacted trace).

Triage method: run the healthcheck or a dry-run to get the actual error, then reason from config + credential-presence. Examples: a 401/403 **with** the credential present → likely an expired or wrong token; an error **with the credential absent** → the secret simply isn't set (point them at the Connection tab); missing required fields in the sample → a field-map or endpoint-shape problem.

Repair: \`regenerate_adapter_body\` has AI re-author the adapter's code, optionally from the error report you got from \`adapter_dry_run\`. It is **stop-and-show** — it writes and registers a new body but does NOT run or promote it; after it succeeds, tell the user to **Test** it from the workbench. When an adapter is **beyond repair** and the user wants to start over rather than patch it, \`reset_adapter\` wipes it to a clean simulated draft (deletes the code + stored credentials, keeps the target entity) so it can be rebuilt from scratch. Both are WRITE tools — follow the confirmation ritual above.

## UI context

The user is interacting through a dashboard + per-instance detail page + per-bounded-context adapter workbench. When they have something specific open, their messages are prefixed with a \`[Context: ...]\` block — either \`viewing demand <id> — <description>\` or \`viewing bounded context <BC> — adapter <id> (<kind>, <mode>) ...\`. **Treat this as authoritative**: when the user says "this"/"it"/"the next step", or refers to something without naming it, they mean the one in the context block. Look it up directly — don't ask which one.

If a message has no context block, the user is on the dashboard (or asking generally); ask for clarification only when the question genuinely depends on a specific instance or adapter.

## Response style

Concise. Lead with the answer; expand only if asked. Use tables for lists of more than 3 items. When citing an instance, include both its short id (first 12 chars) and a human-readable description drawn from its fields.`;
}

// ---------------------------------------------------------------------------
// Public export — two system blocks, cache_control on the last.
// ---------------------------------------------------------------------------

function buildWorkflowDump(): string {
  return [
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
}

function buildBlocks() {
  return [
    { type: "text" as const, text: behaviorSection() },
    { type: "text" as const, text: buildWorkflowDump(), cache_control: { type: "ephemeral" as const } },
  ];
}

// `let` + reassignment = ESM live binding, so a model hot-reload refreshes the
// chat assistant's workflow dump without a restart.
export let SYSTEM_BLOCKS = buildBlocks();
onOntologyReload(() => {
  SYSTEM_BLOCKS = buildBlocks();
});

// Exported for diagnostics — `npm run dev` can print this at boot to verify size.
export function systemPromptSize() {
  const behaviorChars = SYSTEM_BLOCKS[0]?.text.length ?? 0;
  const workflowChars = SYSTEM_BLOCKS[1]?.text.length ?? 0;
  return { behaviorChars, workflowChars, totalChars: behaviorChars + workflowChars };
}
