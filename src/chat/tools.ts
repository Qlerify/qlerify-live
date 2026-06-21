// Tools exposed to the LLM. Each maps onto an existing internal handler or
// a small read against the DB / event log. Write tools (next_step,
// create_demand) require an explicit `confirmed: true` argument — that check
// is enforced both in the tool handler here AND in the system prompt's
// confirmation policy.

import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db.js";
import { EVENTS } from "../events/registry.js";
import {
  genericCurrentStep, genericStep, genericNewInstance, genericListInstances, genericInstanceDetail,
} from "../twin/sim.js";
import { getOntology } from "../ontology/model.js";
import { listAdapters, getAdapter } from "../packs/registry.js";
import { applyFieldMap } from "../packs/types.js";
import { adapterCfg, authorAdapterBody, resetAdapter } from "../packs/author.js";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_demands",
    description:
      "List every instance (run) currently in the simulator with its status, progress (steps fired of total), and dwellSeconds (real wall-clock idleness since the last event). Use this whenever the user asks 'how many are…', 'which ones…', 'show me everything', or needs an overview.",
    input_schema: {
      type: "object",
      properties: {
        olderThanSeconds: {
          type: "number",
          description:
            "Optional filter — only return demands whose dwellSeconds is at least this value. Use for 'stalled', 'stuck', 'haven't moved in N seconds/minutes' queries.",
        },
      },
    },
  },
  {
    name: "find_demand",
    description:
      "Resolve a human description of an instance to its id. Matches against any field on the instance's root aggregate row. Returns one or more matching summaries. Use this when the user references an instance by description rather than by id.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text description matched against the instance's fields.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_demand_details",
    description:
      "Return the full per-instance state: the root aggregate row, the events that have fired, and the rows created across the run grouped by aggregate. Use when the user asks 'what's the state of X' or wants to see specific fields on an instance's aggregates.",
    input_schema: {
      type: "object",
      properties: {
        demandId: { type: "string", description: "The instance id." },
      },
      required: ["demandId"],
    },
  },
  {
    name: "get_event_log",
    description:
      "Return the events that have fired for a demand, newest-first, with their business timestamps. Use when the user asks 'what's happened so far' or 'when did X fire'.",
    input_schema: {
      type: "object",
      properties: {
        demandId: { type: "string", description: "Required — the demand id." },
        limit: { type: "number", description: "Max events to return (default 50)." },
      },
      required: ["demandId"],
    },
  },
  {
    name: "get_workflow_step",
    description:
      "Return the canonical definition of a single step in the workflow — name, bounded context, role, derived flag, command, and acceptance criteria. Use when the user asks 'what does step N do' or 'what gates X'.",
    input_schema: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "1-based step number. Step 1 is the workflow's first event.",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "get_current_step",
    description:
      "Return the next-step-to-fire for a demand. Pairs with 'next_step' for 'what happens if I click step forward on demand X?' questions.",
    input_schema: {
      type: "object",
      properties: {
        demandId: { type: "string" },
      },
      required: ["demandId"],
    },
  },
  {
    name: "next_step",
    description:
      "WRITE — Advance an instance one step forward in the workflow. Requires explicit user confirmation: summarize what will happen, ask 'Shall I proceed?', wait for an explicit yes, then call with `confirmed: true`. The tool refuses with an error if `confirmed` is false.",
    input_schema: {
      type: "object",
      properties: {
        demandId: { type: "string" },
        confirmed: {
          type: "boolean",
          description: "Must be `true`, set only after the user has explicitly confirmed the action.",
        },
      },
      required: ["demandId", "confirmed"],
    },
  },
  {
    name: "create_demand",
    description:
      "WRITE — Create a new instance of the loaded model (instantiates its root aggregate). Requires explicit user confirmation: summarize what will be created, ask 'Shall I proceed?', wait for yes, then call with `confirmed: true`.",
    input_schema: {
      type: "object",
      properties: {
        confirmed: { type: "boolean" },
      },
      required: ["confirmed"],
    },
  },
  // ---- Adapter Connection Doctor (Part 2.3) — diagnose + repair source adapters ----
  {
    name: "list_adapters",
    description:
      "List every registered source adapter (id, kind, bounded context, target entity, provenance mode). Use to find the adapter the user is asking about when troubleshooting a connection.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_adapter_config",
    description:
      "Return an adapter's configuration WITHOUT any secret: kind, bounded context, target entity, mode, endpoint, the credential KEY name (credentialsRef), and whether a generated body exists. Use to inspect how an adapter is wired before diagnosing.",
    input_schema: {
      type: "object",
      properties: { adapterId: { type: "string" } },
      required: ["adapterId"],
    },
  },
  {
    name: "check_adapter_credential",
    description:
      "Check whether the adapter's credential is PRESENT (a boolean — does the env var named by credentialsRef have a value). The secret value is NEVER returned. Use to triage auth failures: present + 401 → likely an expired/invalid token; absent → the credential simply isn't set.",
    input_schema: {
      type: "object",
      properties: { adapterId: { type: "string" } },
      required: ["adapterId"],
    },
  },
  {
    name: "run_adapter_healthcheck",
    description:
      "Run the adapter's healthcheck and return { ok, detail }. Use to confirm whether the source is reachable right now.",
    input_schema: {
      type: "object",
      properties: { adapterId: { type: "string" } },
      required: ["adapterId"],
    },
  },
  {
    name: "adapter_dry_run",
    description:
      "Dry-run the adapter: pull a few rows WITHOUT writing anything, returning a small sample, any missing required fields vs the model, or the thrown error + redacted trace. This is how you obtain the error report to diagnose (and to feed into regenerate_adapter_body).",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        limit: { type: "number", description: "Rows to attempt (default 3)." },
      },
      required: ["adapterId"],
    },
  },
  {
    name: "regenerate_adapter_body",
    description:
      "WRITE — Have AI (re)author the adapter's integration code, optionally from an error report (the self-heal repair). Stop-and-show: it writes + registers a NEW body but does NOT run or promote it — the user tests it afterwards. Requires explicit confirmation: summarize the fix you'll attempt, ask 'Shall I regenerate it?', wait for yes, then call with `confirmed: true`.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        errorReport: { type: "string", description: "The error + redacted trace from adapter_dry_run/healthcheck to repair against (optional)." },
        confirmed: { type: "boolean", description: "Must be `true`, set only after the user confirmed." },
      },
      required: ["adapterId", "confirmed"],
    },
  },
  {
    name: "reset_adapter",
    description:
      "WRITE — Reset an adapter to a clean simulated draft so it can be built from scratch: deletes its AI-authored code and stored credentials (keeps the adapter shell + its target entity). Use when an adapter is beyond repair and the user wants to start over rather than patch it. Requires explicit confirmation: state that the code + credentials will be wiped, ask 'Shall I reset it?', wait for yes, then call with `confirmed: true`.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        confirmed: { type: "boolean", description: "Must be `true`, set only after the user confirmed." },
      },
      required: ["adapterId", "confirmed"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface ToolResult {
  content: string;
  isError: boolean;
}

function ok(payload: unknown): ToolResult {
  // Compact JSON (no indent) keeps the result on a single line. Multi-line JSON
  // would embed literal \n in the response body — and some Fastify configs do
  // not escape control chars inside nested object strings, producing invalid
  // wire JSON that downstream parsers reject.
  return { content: typeof payload === "string" ? payload : JSON.stringify(payload), isError: false };
}

function err(message: string): ToolResult {
  return { content: `ERROR: ${message}`, isError: true };
}

export async function runTool(name: string, input: unknown): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, any>;
  try {
    switch (name) {
      case "list_demands":
        return ok(await handleListDemands(args.olderThanSeconds));
      case "find_demand":
        return ok(await handleFindDemand(String(args.query ?? "")));
      case "get_demand_details":
        return ok(await handleGetDemandDetails(String(args.demandId ?? "")));
      case "get_event_log":
        return ok(await handleGetEventLog(String(args.demandId ?? ""), Number(args.limit ?? 50)));
      case "get_workflow_step":
        return ok(handleGetWorkflowStep(Number(args.index)));
      case "get_current_step":
        return ok(await handleGetCurrentStep(String(args.demandId ?? "")));
      case "next_step":
        return await handleNextStep(args);
      case "create_demand":
        return await handleCreateDemand(args);
      case "list_adapters":
        return ok(handleListAdapters());
      case "get_adapter_config":
        return ok(handleGetAdapterConfig(String(args.adapterId ?? "")));
      case "check_adapter_credential":
        return ok(handleCheckAdapterCredential(String(args.adapterId ?? "")));
      case "run_adapter_healthcheck":
        return ok(await handleRunAdapterHealthcheck(String(args.adapterId ?? "")));
      case "adapter_dry_run":
        return ok(await handleAdapterDryRun(String(args.adapterId ?? ""), Number(args.limit ?? 3)));
      case "regenerate_adapter_body":
        return await handleRegenerateAdapterBody(args);
      case "reset_adapter":
        return handleResetAdapter(args);
      default:
        return err(`unknown tool: ${name}`);
    }
  } catch (e: any) {
    return err(e?.message ?? String(e));
  }
}

// ---------------------------------------------------------------------------
// Read handlers
// ---------------------------------------------------------------------------

async function handleListDemands(olderThanSeconds?: number) {
  const now = Date.now();
  const instances = await genericListInstances();
  const out = instances
    .map((d: any) => {
      const occurredAt = d.lastEvent?.occurredAt ?? null;
      const dwellSeconds = occurredAt ? Math.round((now - new Date(occurredAt).getTime()) / 1000) : null;
      const { lastEvent, ...row } = d;
      return { ...row, lastEventName: lastEvent?.eventName ?? null, dwellSeconds };
    })
    .filter((row: any) => olderThanSeconds == null || (row.dwellSeconds ?? 0) >= olderThanSeconds);
  return { demands: out, count: out.length, threshold: olderThanSeconds ?? null };
}

async function handleFindDemand(query: string) {
  const q = query.toLowerCase().trim();
  if (!q) return { matches: [] };
  const toks = q.split(/\s+/);
  const instances = await genericListInstances();
  const matches = instances.filter((d: any) => {
    const blob = JSON.stringify(d).toLowerCase();
    return toks.every((tok) => blob.includes(tok));
  });
  return {
    query,
    matches: matches.map((d: any) => {
      const { lastEvent, progress, total, ...row } = d;
      return row;
    }),
  };
}

async function handleGetDemandDetails(demandId: string) {
  const detail = await genericInstanceDetail(demandId);
  if (!detail.root) return { error: `no instance ${demandId}` };
  return detail;
}

async function handleGetEventLog(demandId: string, limit: number) {
  const log = await prisma.eventLog.findMany({
    where: { demandId },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: { eventName: true, eventRef: true, boundedContext: true, role: true, businessAt: true, occurredAt: true },
  });
  return { demandId, events: log };
}

function handleGetWorkflowStep(index1Based: number) {
  if (!Number.isInteger(index1Based) || index1Based < 1 || index1Based > EVENTS.length) {
    return { error: `step must be between 1 and ${EVENTS.length}` };
  }
  const i = index1Based - 1;
  const e = EVENTS[i]!;
  const spec = getOntology().eventByRef(e.ref);
  return {
    step: index1Based,
    name: e.name,
    ref: e.ref,
    boundedContext: e.boundedContext,
    aggregateRoot: e.aggregateRoot,
    role: e.role,
    phase: e.phase,
    derived: !!e.derived,
    command: spec?.commandName ?? null,
    acceptanceCriteria: spec?.acceptanceCriteria ?? [],
  };
}

async function handleGetCurrentStep(demandId: string) {
  const { index, total } = await genericCurrentStep(demandId);
  if (index >= total) return { demandId, done: true, completedSteps: total };
  const e = EVENTS[index]!;
  return {
    demandId,
    nextStep: index + 1,
    name: e.name,
    boundedContext: e.boundedContext,
    role: e.role,
    derived: !!e.derived,
  };
}

// ---------------------------------------------------------------------------
// Write handlers — gated on `confirmed: true`
// ---------------------------------------------------------------------------

async function handleNextStep(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. You must obtain an explicit user confirmation first, then call again with confirmed=true.");
  }
  const demandId = String(args.demandId ?? "");
  if (!demandId) return err("demandId required");
  const result = await genericStep(demandId);
  return ok({
    stepFired: result.index + 1,
    eventName: result.eventName,
    caption: result.caption,
    done: result.done,
  });
}

async function handleCreateDemand(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. You must obtain an explicit user confirmation first, then call again with confirmed=true.");
  }
  const result = await genericNewInstance();
  return ok({ demandId: result.id, aggregate: result.aggregate });
}

// ---------------------------------------------------------------------------
// Adapter Connection Doctor (Part 2.3)
// ---------------------------------------------------------------------------

function handleListAdapters() {
  return {
    adapters: listAdapters().map((a) => ({
      id: a.id, kind: a.kind, boundedContext: a.boundedContext, targetEntity: a.targetEntity, mode: a.mode,
    })),
  };
}

function handleGetAdapterConfig(adapterId: string) {
  const cfg = adapterCfg(adapterId);
  if (!cfg) return { error: `no adapter "${adapterId}"` };
  return {
    id: cfg.id, kind: cfg.kind, boundedContext: cfg.boundedContext, targetEntity: cfg.targetEntity,
    mode: cfg.mode, endpoint: cfg.endpoint ?? null, credentialsRef: cfg.credentialsRef ?? null,
    hasBody: !!cfg.bodyPath, bodyPath: cfg.bodyPath ?? null,
    // The secret is NEVER returned by this tool.
  };
}

function handleCheckAdapterCredential(adapterId: string) {
  const cfg = adapterCfg(adapterId);
  if (!cfg) return { error: `no adapter "${adapterId}"` };
  if (!cfg.credentialsRef) return { credentialsRef: null, present: false, note: "no credential key configured for this adapter" };
  return { credentialsRef: cfg.credentialsRef, present: !!process.env[cfg.credentialsRef] }; // boolean only — value never read
}

async function handleRunAdapterHealthcheck(adapterId: string) {
  const a = getAdapter(adapterId);
  if (!a) return { error: `no adapter "${adapterId}"` };
  try {
    return await a.healthcheck();
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

async function handleAdapterDryRun(adapterId: string, limit: number) {
  const a = getAdapter(adapterId);
  if (!a) return { error: `no adapter "${adapterId}"` };
  const entity = getOntology().entity(a.targetEntity);
  try {
    const fieldMap = await a.mapping();
    const { rows } = await a.pull({ limit: limit > 0 ? limit : 3 });
    const mapped = (rows[a.targetEntity] ?? []).map((r) => applyFieldMap(r, fieldMap));
    const missingRequired = entity
      ? entity.required.filter((f) => mapped.length === 0 || mapped.some((r) => r[f] === undefined || r[f] === null || r[f] === ""))
      : [];
    return { ok: true, count: mapped.length, sample: mapped.slice(0, 2), missingRequired };
  } catch (e: any) {
    // The error report the doctor reasons about (and can pass to regenerate).
    return { ok: false, error: e?.message ?? String(e) };
  }
}

async function handleRegenerateAdapterBody(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Summarize the repair, get the user's explicit yes, then call again with confirmed=true.");
  }
  const adapterId = String(args.adapterId ?? "");
  if (!adapterId) return err("adapterId required");
  if (!process.env.ANTHROPIC_API_KEY) return err("ANTHROPIC_API_KEY not set — cannot author/repair an adapter body");
  const r = await authorAdapterBody(adapterId, typeof args.errorReport === "string" ? args.errorReport : undefined);
  return ok({
    regenerated: true, adapterId, bodyPath: r.bodyPath, skipped: r.skipped,
    note: "New body written + registered, but NOT run or promoted (stop-and-show). Tell the user to Test it from the workbench, then promote if it passes.",
  });
}

function handleResetAdapter(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Tell the user the code + credentials will be wiped, get an explicit yes, then call again with confirmed=true.");
  }
  const id = String(args.adapterId ?? "");
  if (!id) return err("adapterId required");
  const fresh = resetAdapter(id);
  return ok({
    reset: true, adapterId: id, kind: fresh.kind, mode: fresh.mode,
    note: "Adapter wiped to a clean simulated draft (code + credentials deleted). Re-configure the connection, then regenerate the body to build from scratch.",
  });
}
