// Tools exposed to the LLM. Each maps onto an existing internal handler or
// a small read against the DB / event log. Write tools (next_step,
// create_case) require an explicit `confirmed: true` argument — that check
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
import {
  createConnector, setConnectorCredentials, copyConnectorCredentials, buildConnector,
  connectorInfo, readConnectorCode, removeConnector,
} from "../packs/connector/orchestrate.js";
import { readDoc, connectorChatId } from "../packs/connector/journal.js";
import { ingestPull } from "../packs/ingest.js";
import { guardData } from "../platform/authz.js";
import { ownsAdapterId } from "../packs/ownership.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { connectorsEnabled } from "../config/features.js";

// Chat WRITE tools → the PDP action they require. The chat loop runs each tool
// under withActorKind("ai"), so a deny here is audited as an AI guardrail block
// (Workstream C) and returned to the model as a tool error. Tools absent from this
// map are reads (no state change) and stay membership-scoped. This server-side
// gate — not the model-asserted `confirmed:true` flag — is the security boundary,
// so a prompt-injected turn can never escalate past the caller's own grants.
const TOOL_WRITE_ACTIONS: Record<string, string> = {
  next_step: "workflow.sim.write",
  create_case: "workflow.sim.write",
  // Authoring connector/adapter code (the RCE surface) needs special access.
  regenerate_adapter_body: "connector.build",
  create_connector: "connector.build",
  build_connector: "connector.build",
  reset_adapter: "connector.administer",
  set_connector_credentials: "connector.edit",
  ingest_connector: "connector.edit",
  copy_connector_credentials: "connector.edit",
  remove_connector: "connector.administer",
};

// WRITE/EXEC tools that address an EXISTING adapter/connector by `adapterId`. Each
// must touch only an adapter owned by the caller's workflow — the registry/sidecar
// store is process-global and id-keyed, so without this any tenant could
// run/repair/delete another tenant's connector by guessing its id (F-16 / F-20).
// The READ tools (get_adapter_config / check_adapter_credential /
// run_adapter_healthcheck / adapter_dry_run / view_connector_code) enforce
// ownership INSIDE their handlers instead, returning the SAME not-found shape as an
// unknown id so a foreign-owned id is not a cross-tenant existence oracle.
// copy_connector_credentials (from/to) and get_connector_history (optional id) are
// likewise checked inside their own handlers.
const TOOL_OWNED_ID: ReadonlySet<string> = new Set([
  "regenerate_adapter_body", "reset_adapter", "set_connector_credentials", "build_connector",
  "ingest_connector", "remove_connector",
]);

// Connector READ / EXEC tools that are NOT in TOOL_WRITE_ACTIONS (so the guardData
// connector.* kill-switch never fires for them). They disclose connector source /
// credential field names or execute an authored body, so the D7 kill-switch must
// gate them directly — otherwise they keep working when the operator has disabled
// the subsystem (QLERIFY_CONNECTORS_ENABLED=false).
const TOOL_CONNECTOR_KILLSWITCH: ReadonlySet<string> = new Set([
  "get_adapter_config", "check_adapter_credential", "run_adapter_healthcheck", "adapter_dry_run",
  "view_connector_code", "get_connector_history", "list_connector_credentials",
]);

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_cases",
    description:
      "List every instance (run) currently in the simulator with its status, progress (steps fired of total), and dwellSeconds (real wall-clock idleness since the last event). Use this whenever the user asks 'how many are…', 'which ones…', 'show me everything', or needs an overview.",
    input_schema: {
      type: "object",
      properties: {
        olderThanSeconds: {
          type: "number",
          description:
            "Optional filter — only return cases whose dwellSeconds is at least this value. Use for 'stalled', 'stuck', 'haven't moved in N seconds/minutes' queries.",
        },
      },
    },
  },
  {
    name: "find_case",
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
    name: "get_case_details",
    description:
      "Return the full per-instance state: the root aggregate row, the events that have fired, and the rows created across the run grouped by aggregate. Use when the user asks 'what's the state of X' or wants to see specific fields on an instance's aggregates.",
    input_schema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "The instance id." },
      },
      required: ["caseId"],
    },
  },
  {
    name: "get_event_log",
    description:
      "Return the events that have fired for a case, newest-first, with their business timestamps. Use when the user asks 'what's happened so far' or 'when did X fire'.",
    input_schema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "Required — the case id." },
        limit: { type: "number", description: "Max events to return (default 50)." },
      },
      required: ["caseId"],
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
      "Return the next-step-to-fire for a case. Pairs with 'next_step' for 'what happens if I click step forward on case X?' questions.",
    input_schema: {
      type: "object",
      properties: {
        caseId: { type: "string" },
      },
      required: ["caseId"],
    },
  },
  {
    name: "next_step",
    description:
      "WRITE — Advance an instance one step forward in the workflow. Requires explicit user confirmation: summarize what will happen, ask 'Shall I proceed?', wait for an explicit yes, then call with `confirmed: true`. The tool refuses with an error if `confirmed` is false.",
    input_schema: {
      type: "object",
      properties: {
        caseId: { type: "string" },
        confirmed: {
          type: "boolean",
          description: "Must be `true`, set only after the user has explicitly confirmed the action.",
        },
      },
      required: ["caseId", "confirmed"],
    },
  },
  {
    name: "create_case",
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
  // ---- Connector Builder (Part 2.4) — build full-power connectors on the fly ----
  {
    name: "list_model_kinds",
    description:
      "List each system (bounded context) with its entities and value objects, plus the connectors/adapters already on it. Use to find the right target to populate, or to check what already exists, when the user's selection is ambiguous. The user's [Context: ...] block usually already names the system + table — prefer that.",
    input_schema: {
      type: "object",
      properties: { boundedContext: { type: "string", description: "Optional — limit to one system." } },
    },
  },
  {
    name: "create_connector",
    description:
      "WRITE — Create a new full-power connector for a system, targeting one kind (an entity OR a value object). It starts empty; you then set credentials (if needed), build its code, test, and ingest. The connector can integrate with anything (databases, cloud SDKs, REST/SOAP, files). Requires confirmation: state the system + target, ask 'Shall I create it?', wait for yes, then call with confirmed:true.",
    input_schema: {
      type: "object",
      properties: {
        boundedContext: { type: "string", description: "The system / bounded context name." },
        target: { type: "string", description: "The entity or value-object name this connector populates." },
        id: { type: "string", description: "Optional explicit connector id; defaults to <system>-<target>." },
        confirmed: { type: "boolean" },
      },
      required: ["boundedContext", "target", "confirmed"],
    },
  },
  {
    name: "set_connector_credentials",
    description:
      "Store the connector's credentials as a JSON object of ANY shape — e.g. {accessKeyId, secretAccessKey, region, table} for DynamoDB, {apiKey} for a REST API, {connectionString} for Postgres. Stored plaintext for this PoC. Only the FIELD NAMES are ever echoed back, never the values. Collect the needed fields from the user, then call this. No separate confirmation — the user providing them is the consent.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        credentials: { type: "object", description: "Credential fields as a JSON object. Values are secret and never shown back.", additionalProperties: true },
      },
      required: ["adapterId", "credentials"],
    },
  },
  {
    name: "build_connector",
    description:
      "WRITE — Have AI write (or repair) the connector's integration code from a natural-language description of the source, then auto-install whatever npm packages the code imports. The connector may use ANY package or protocol (AWS SDK, pg, googleapis, fetch, soap…). Stop-and-show: it writes + registers the code but does NOT run or ingest — test it next with adapter_dry_run. To REPAIR a failed connector, pass errorReport (the error + trace from the failed adapter_dry_run) and it will rewrite the code to fix it. Requires confirmation: summarize what you'll build/fix, ask 'Shall I build it?', wait for yes, then call with confirmed:true.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        instructions: { type: "string", description: "Natural-language description of the source and how to read it (which table/endpoint/query, pagination, shape). Persisted; on a repair turn you can omit it to reuse the last one." },
        errorReport: { type: "string", description: "On a repair turn: the error + redacted trace from the failed adapter_dry_run, so the AI can fix the code." },
        confirmed: { type: "boolean" },
      },
      required: ["adapterId", "confirmed"],
    },
  },
  {
    name: "ingest_connector",
    description:
      "WRITE — Run the connector for real and LAND its rows into the target table (gen_<kind>), so they appear in the explorer's Items pane. Only do this after a successful adapter_dry_run. Requires confirmation: state how many rows you'll pull into which table, ask 'Shall I populate it?', wait for yes, then call with confirmed:true.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        limit: { type: "number", description: "Max rows to ingest (default 25)." },
        confirmed: { type: "boolean" },
      },
      required: ["adapterId", "confirmed"],
    },
  },
  {
    name: "view_connector_code",
    description:
      "Return the connector's current source code and its detected npm dependencies. Use when the user asks to see or review the connector code.",
    input_schema: {
      type: "object",
      properties: { adapterId: { type: "string" } },
      required: ["adapterId"],
    },
  },
  {
    name: "get_connector_history",
    description:
      "Return a connector's documentation: its one-line summary plus the timestamped update-notes log (created, credentials set, code built/repaired, rows ingested). This is the same history the user sees on the sidebar's History tab. Read it before building, repairing, or re-ingesting so you recall what's already been done and don't repeat work or contradict an earlier step. Identify the connector by adapterId, or by boundedContext + target.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        boundedContext: { type: "string" },
        target: { type: "string" },
      },
    },
  },
  {
    name: "list_connector_credentials",
    description:
      "READ-ONLY — List every connector with the NAMES of its stored credential fields and whether credentials are present. Secret VALUES are never returned. Use to discover what credentials other connectors already have, e.g. when the user says 'use the same credentials as the other connector' — find the matching source here, then call copy_connector_credentials.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "copy_connector_credentials",
    description:
      "WRITE (destination only) — Reuse another connector's stored credentials for the connector you're building: copies the source's credential blob to the destination, server-side. Secret VALUES are never shown — only the field names are reported. Use for 'use the same credentials as the X connector'. State which source connector you're copying from before calling. The source is read-only; only the destination is written.",
    input_schema: {
      type: "object",
      properties: {
        fromAdapterId: { type: "string", description: "the connector to copy credentials FROM" },
        toAdapterId: { type: "string", description: "the connector to copy credentials TO (the one you're building)" },
      },
      required: ["fromAdapterId", "toAdapterId"],
    },
  },
  {
    name: "remove_connector",
    description:
      "WRITE — Delete a connector entirely (its code, stored credentials, and config). Use for 'delete this connector' or 'start over'. Rows already ingested into the table are left as-is. Requires confirmation: ask 'Shall I delete it?', wait for yes, then call with confirmed:true.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        confirmed: { type: "boolean" },
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
    // Authorize write tools against the active workflow before dispatch. A deny
    // throws here, is audited (ensureAllowed), and surfaces to the model as a
    // tool error via the catch below.
    const action = TOOL_WRITE_ACTIONS[name];
    if (action) await guardData(action);
    // D7 kill-switch for connector read/exec tools (writes are covered by guardData
    // above, whose connector.* gate already throws when the subsystem is disabled).
    if (TOOL_CONNECTOR_KILLSWITCH.has(name) && !connectorsEnabled()) {
      return err("the connector / AI-codegen subsystem is disabled for this deployment");
    }
    // Tenant-ownership gate for WRITE/EXEC tools: an id-addressed tool may only
    // touch an adapter owned by the caller's workflow. (READ tools enforce
    // ownership inside their handlers with the unknown-id shape, so they don't leak
    // an existence oracle.)
    if (TOOL_OWNED_ID.has(name)) {
      const idArg = typeof args.adapterId === "string" ? args.adapterId : "";
      if (idArg && !ownsAdapterId(idArg)) return err(`no adapter "${idArg}" in this workflow`);
    }
    switch (name) {
      case "list_cases":
        return ok(await handleListCases(args.olderThanSeconds));
      case "find_case":
        return ok(await handleFindCase(String(args.query ?? "")));
      case "get_case_details":
        return ok(await handleGetCaseDetails(String(args.caseId ?? "")));
      case "get_event_log":
        return ok(await handleGetEventLog(String(args.caseId ?? ""), Number(args.limit ?? 50)));
      case "get_workflow_step":
        return ok(handleGetWorkflowStep(Number(args.index)));
      case "get_current_step":
        return ok(await handleGetCurrentStep(String(args.caseId ?? "")));
      case "next_step":
        return await handleNextStep(args);
      case "create_case":
        return await handleCreateCase(args);
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
      case "list_model_kinds":
        return ok(handleListModelKinds(typeof args.boundedContext === "string" ? args.boundedContext : undefined));
      case "create_connector":
        return handleCreateConnector(args);
      case "set_connector_credentials":
        return await handleSetConnectorCredentials(args);
      case "build_connector":
        return await handleBuildConnector(args);
      case "ingest_connector":
        return await handleIngestConnector(args);
      case "view_connector_code":
        return ok(handleViewConnectorCode(String(args.adapterId ?? "")));
      case "get_connector_history":
        return handleGetConnectorHistory(args);
      case "list_connector_credentials":
        return ok(handleListConnectorCredentials());
      case "copy_connector_credentials":
        return await handleCopyConnectorCredentials(args);
      case "remove_connector":
        return handleRemoveConnector(args);
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

async function handleListCases(olderThanSeconds?: number) {
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
  return { cases: out, count: out.length, threshold: olderThanSeconds ?? null };
}

async function handleFindCase(query: string) {
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

async function handleGetCaseDetails(caseId: string) {
  const detail = await genericInstanceDetail(caseId);
  if (!detail.root) return { error: `no instance ${caseId}` };
  return detail;
}

async function handleGetEventLog(caseId: string, limit: number) {
  const log = await prisma.eventLog.findMany({
    // Scope to the active workflow/org — without this a caseId from another tenant
    // would disclose that case's event metadata (F-26 cross-tenant read).
    where: { caseId, ...eventLogOrgWhere() },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: { eventName: true, eventRef: true, boundedContext: true, role: true, businessAt: true, occurredAt: true },
  });
  return { caseId, events: log };
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

async function handleGetCurrentStep(caseId: string) {
  const { index, total } = await genericCurrentStep(caseId);
  if (index >= total) return { caseId, done: true, completedSteps: total };
  const e = EVENTS[index]!;
  return {
    caseId,
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
  const caseId = String(args.caseId ?? "");
  if (!caseId) return err("caseId required");
  const result = await genericStep(caseId);
  return ok({
    stepFired: result.index + 1,
    eventName: result.eventName,
    caption: result.caption,
    done: result.done,
  });
}

async function handleCreateCase(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. You must obtain an explicit user confirmation first, then call again with confirmed=true.");
  }
  const result = await genericNewInstance();
  return ok({ caseId: result.id, aggregate: result.aggregate });
}

// ---------------------------------------------------------------------------
// Adapter Connection Doctor (Part 2.3)
// ---------------------------------------------------------------------------

function handleListAdapters() {
  return {
    adapters: listAdapters().filter((a) => ownsAdapterId(a.id)).map((a) => ({
      id: a.id, kind: a.kind, boundedContext: a.boundedContext, targetEntity: a.targetEntity, mode: a.mode,
    })),
  };
}

function handleGetAdapterConfig(adapterId: string) {
  if (!ownsAdapterId(adapterId)) return { error: `no adapter "${adapterId}"` }; // foreign ≡ unknown (no oracle)
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
  if (!ownsAdapterId(adapterId)) return { error: `no adapter "${adapterId}"` }; // foreign ≡ unknown (no oracle)
  const cfg = adapterCfg(adapterId);
  if (!cfg) return { error: `no adapter "${adapterId}"` };
  if (!cfg.credentialsRef) return { credentialsRef: null, present: false, note: "no credential key configured for this adapter" };
  return { credentialsRef: cfg.credentialsRef, present: !!process.env[cfg.credentialsRef] }; // boolean only — value never read
}

async function handleRunAdapterHealthcheck(adapterId: string) {
  if (!ownsAdapterId(adapterId)) return { error: `no adapter "${adapterId}"` }; // foreign ≡ unknown (no oracle); also blocks cross-tenant exec
  const a = getAdapter(adapterId);
  if (!a) return { error: `no adapter "${adapterId}"` };
  try {
    return await a.healthcheck();
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

async function handleAdapterDryRun(adapterId: string, limit: number) {
  if (!ownsAdapterId(adapterId)) return { error: `no adapter "${adapterId}"` }; // foreign ≡ unknown (no oracle); also blocks cross-tenant exec
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

// ---------------------------------------------------------------------------
// Connector Builder (Part 2.4)
// ---------------------------------------------------------------------------

function handleListModelKinds(bcFilter?: string) {
  const o = getOntology();
  const adapters = listAdapters();
  const want = (bc: string) => !bcFilter || bc.toLowerCase() === bcFilter.toLowerCase();
  const systems = o.boundedContexts.filter(want).map((bc) => {
    const entities = o.entities.filter((e) => o.boundedContextOf(e.name) === bc);
    const voNames = new Set<string>();
    for (const e of entities) {
      for (const f of e.fields) if (f.relatedEntity && o.valueObject(f.relatedEntity)) voNames.add(f.relatedEntity);
    }
    return {
      system: bc,
      entities: entities.map((e) => e.name),
      valueObjects: [...voNames],
      connectors: adapters
        .filter((a) => a.boundedContext === bc && ownsAdapterId(a.id))
        .map((a) => ({ id: a.id, kind: a.kind, target: a.targetEntity, mode: a.mode })),
    };
  });
  return { systems };
}

function handleCreateConnector(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Confirm the system + target with the user first, then call again with confirmed=true.");
  }
  const boundedContext = String(args.boundedContext ?? "");
  const target = String(args.target ?? "");
  if (!boundedContext || !target) return err("boundedContext and target are required");
  const cfg = createConnector({ boundedContext, target, id: typeof args.id === "string" ? args.id : undefined });
  return ok({
    created: true, adapterId: cfg.id, boundedContext: cfg.boundedContext, target: cfg.targetEntity, targetKind: cfg.targetKind,
    note: "Empty connector created. Next: if the source needs auth, collect the fields and call set_connector_credentials; then build_connector with a description of the source.",
  });
}

async function handleSetConnectorCredentials(args: Record<string, any>) {
  const id = String(args.adapterId ?? "");
  if (!id) return err("adapterId required");
  const creds = args.credentials;
  if (!creds || typeof creds !== "object" || Array.isArray(creds)) return err("credentials must be a JSON object of fields");
  const keys = await setConnectorCredentials(id, creds as Record<string, unknown>);
  return ok({ stored: true, adapterId: id, credentialKeys: keys, note: "Stored (plaintext, PoC). Values are never echoed back. Now build_connector." });
}

async function handleBuildConnector(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Summarize what you'll build (or fix), get the user's explicit yes, then call again with confirmed=true.");
  }
  const id = String(args.adapterId ?? "");
  if (!id) return err("adapterId required");
  if (!process.env.ANTHROPIC_API_KEY) return err("ANTHROPIC_API_KEY not set — cannot author a connector");
  const r = await buildConnector(
    id,
    typeof args.instructions === "string" ? args.instructions : undefined,
    typeof args.errorReport === "string" ? args.errorReport : undefined,
  );
  return ok({
    built: true, adapterId: id, targetKind: r.targetKind, dependencies: r.deps, codeBytes: r.bytes,
    install: { ok: r.install.ok, installed: r.install.installed, skipped: r.install.skipped, ...(r.install.ok ? {} : { log: r.install.log }) },
    note: r.install.ok
      ? "Code written + packages installed. Now TEST it with adapter_dry_run before ingesting. If it errors, call build_connector again with the errorReport to fix it."
      : "Code written but some npm packages failed to install (see install.log). The dry-run will likely fail until deps resolve.",
  });
}

async function handleIngestConnector(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Confirm the row count + target table with the user first, then call again with confirmed=true.");
  }
  const id = String(args.adapterId ?? "");
  if (!id) return err("adapterId required");
  const limit = Number(args.limit ?? 25);
  // ingestPull journals the "ingested" note itself (one place for every caller).
  const summary = await ingestPull(id, { limit: limit > 0 ? limit : 25 });
  const ev = summary.derived && summary.derived.events
    ? ` Derived ${summary.derived.events} domain event(s) across ${summary.derived.instances} instance(s) from the new rows.`
    : "";
  return ok({
    ingested: true, ...summary,
    note: `Landed ${summary.inserted} new row(s) (${summary.skipped} already present) into ${summary.entity}. They now appear in the explorer's Items pane.${ev}`,
  });
}

function handleViewConnectorCode(id: string) {
  if (!id) return { error: "adapterId required" };
  if (!ownsAdapterId(id)) return { error: `no connector "${id}"` }; // foreign ≡ unknown (no oracle)
  const info = connectorInfo(id);
  if (!info) return { error: `no connector "${id}"` };
  return { adapterId: id, target: info.target, targetKind: info.targetKind, dependencies: info.deps, hasCode: info.hasCode, credentialKeys: info.credentialKeys, code: readConnectorCode(id) ?? null };
}

function handleGetConnectorHistory(args: Record<string, any>) {
  let id = typeof args.adapterId === "string" && args.adapterId ? args.adapterId : "";
  if (!id && typeof args.boundedContext === "string" && typeof args.target === "string") {
    id = connectorChatId(args.boundedContext, args.target); // default connector id = slug(bc-target)
  }
  if (!id) return err("adapterId (or boundedContext + target) required");
  // A non-owned (or unknown) connector returns the same "no history" shape as a
  // genuinely empty one, so it never discloses another tenant's connector.
  const doc = ownsAdapterId(id) ? readDoc(id) : null;
  if (!doc) return ok({ adapterId: id, summary: null, notes: [], note: "No update history recorded for this connector yet." });
  return ok({ adapterId: id, summary: doc.summary ?? null, notes: doc.notes, updatedAt: doc.updatedAt });
}

// Read-only: every connector with its credential FIELD NAMES (never values), so
// the agent can find a source to copy from for "use the same credentials as …".
function handleListConnectorCredentials() {
  const connectors = listAdapters()
    .filter((a) => a.kind === "connector" && ownsAdapterId(a.id))
    .map((a) => {
      const fields = connectorInfo(a.id)?.credentialKeys ?? [];
      return { adapterId: a.id, boundedContext: a.boundedContext, target: a.targetEntity, credentialFields: fields, hasCredentials: fields.length > 0 };
    });
  return { connectors };
}

async function handleCopyConnectorCredentials(args: Record<string, any>) {
  const from = String(args.fromAdapterId ?? "");
  const to = String(args.toAdapterId ?? "");
  if (!from || !to) return err("fromAdapterId and toAdapterId required");
  // Authorize BOTH ends: the SOURCE check is what stops a tenant copying (and then
  // echoing back) another tenant's stored credential blob (F-05).
  if (!ownsAdapterId(from)) return err(`no adapter "${from}" in this workflow`);
  if (!ownsAdapterId(to)) return err(`no adapter "${to}" in this workflow`);
  const keys = await copyConnectorCredentials(from, to); // throws on bad ids / no creds; values never returned
  return ok({ copied: true, fromAdapterId: from, toAdapterId: to, credentialFields: keys, note: `Reused ${keys.length} credential field(s) from ${from}. Values were copied server-side and never shown.` });
}

function handleRemoveConnector(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Confirm deletion with the user first, then call again with confirmed=true.");
  }
  const id = String(args.adapterId ?? "");
  if (!id) return err("adapterId required");
  removeConnector(id);
  return ok({ removed: true, adapterId: id, note: "Connector code, credentials, and config deleted. Ingested rows (if any) were left in the table." });
}
