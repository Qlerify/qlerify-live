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
  connectorInfo, readConnectorCode, removeConnector, discoverSourceFields,
  setConnectorBehavior, setConnectorTargetSystem, regenerateConnectorSummary,
} from "../packs/connector/orchestrate.js";
import { fetchDocs } from "./fetch-docs.js";
import { readDoc, connectorChatId, setConnectorSummary, appendNote } from "../packs/connector/journal.js";
import { previewRule } from "../packs/connector/rules.js";
import { compileTriggerRule } from "../packs/connector/rules-codegen.js";
import { ingestPull } from "../packs/ingest.js";
import type { AdapterBehavior } from "../packs/types.js";
import { assertActionsConfirmed, performsActions } from "../packs/behavior.js";
import { ScheduleError, nextRunAt, setConnectorSchedule } from "../packs/scheduler.js";
import { guardData } from "../platform/authz.js";
import { resolveAnthropicStatus } from "../llm/anthropic.js";
import { ownsAdapterId } from "../packs/ownership.js";
import { eventLogOrgWhere } from "../platform/tenancy/event-scope.js";
import { connectorsEnabled } from "../config/features.js";
import * as store from "../twin/projection-store.js";

// Chat WRITE tools → the PDP action they require. The chat loop runs each tool
// under withActorKind("ai"), so a deny here is audited as an AI guardrail block
// (Workstream C) and returned to the model as a tool error. Tools absent from this
// map are reads (no state change) and stay membership-scoped. This server-side
// gate — not the model-asserted `confirmed:true` flag — is the security boundary,
// so a prompt-injected turn can never escalate past the caller's own grants.
const BEHAVIORS: ReadonlySet<string> = new Set(["sync", "generator", "actuator", "extractor"]);

const TOOL_WRITE_ACTIONS: Record<string, string> = {
  next_step: "workflow.sim.write",
  create_case: "workflow.sim.write",
  // Authoring connector/adapter code (the RCE surface) needs special access.
  regenerate_adapter_body: "connector.build",
  create_connector: "connector.build",
  build_connector: "connector.build",
  build_trigger_rules: "connector.build",
  // Discovery executes connector code AND persists the observed shape on the
  // sidecar; docs fetching is an AI-driven outbound network request. Both ride
  // the connector-authoring capability (and its kill-switch, via guardData).
  discover_source_fields: "connector.build",
  fetch_docs: "connector.build",
  // Same capability the Schedule panel's route guards: enabling polling starts
  // unattended runs against a live source, so the chat is never the softer path.
  set_connector_schedule: "connector.build",
  // Reclassifying is the same class of consequence: marking something NOT an
  // actuator lets a model rebuild fire its writes again.
  set_connector_behavior: "connector.build",
  // Ships the connector's code to the LLM, the same disclosure build_connector rides.
  update_connector_description: "connector.build",
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
  "build_trigger_rules", "ingest_connector", "remove_connector", "discover_source_fields",
  "set_connector_schedule", "set_connector_behavior", "update_connector_description",
]);

// Connector READ / EXEC tools that are NOT in TOOL_WRITE_ACTIONS (so the guardData
// connector.* kill-switch never fires for them). They disclose connector source /
// credential field names or execute an authored body, so the D7 kill-switch must
// gate them directly — otherwise they keep working when the operator has disabled
// the subsystem (QLERIFY_CONNECTORS_ENABLED=false).
const TOOL_CONNECTOR_KILLSWITCH: ReadonlySet<string> = new Set([
  "get_adapter_config", "check_adapter_credential", "run_adapter_healthcheck", "adapter_dry_run",
  "view_connector_code", "get_connector_history", "list_connector_credentials", "preview_trigger_rule",
]);

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_cases",
    description:
      "List every instance (run) currently in the simulator with its status, progress (steps fired, of the total steps on that run's own branch path), and dwellSeconds (real wall-clock idleness since the last event). Use this whenever the user asks 'how many are…', 'which ones…', 'show me everything', or needs an overview.",
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
      "Return the events that have fired for a case, newest-first, with their business timestamps where known (businessAt is null when no source date anchors the event — the moment is unknown). Use when the user asks 'what's happened so far' or 'when did X fire'.",
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
      "Return an adapter's configuration WITHOUT any secret: `kind`, `boundedContext`, `targetEntity`, `behavior` (the connector's type) and `targetSystem`, `mode`, `endpoint`, the credential KEY name (`credentialsRef`), whether a generated body exists, the current `description`, and `instructions` — the brief its code was authored from. Use to inspect how an adapter is wired before diagnosing, and ALWAYS before a build_connector that adds to an existing connector, since that call replaces the brief wholesale and you need the old text to resend it complete.",
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
      "Dry-run the adapter: pull a few rows and land NOTHING in the target table, returning a small sample, any missing required fields vs the model, the extra source fields beyond the model (extraFields — informational, NOT an error: ingest preserves them in the row's _raw JSON column), or the thrown error + redacted trace. This is how you obtain the error report to diagnose (and to feed into regenerate_adapter_body). NOT read-only on an `actuator`: there the pull IS the action, so it creates records in the other system for real and the platform refuses unless confirmActions is set. On an actuator prefer run_adapter_healthcheck to check reachability, and ingest_connector when the user wants the actions performed.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        limit: { type: "number", description: "Rows to attempt (default 3)." },
        confirmActions: {
          type: "boolean",
          description:
            "Only for an `actuator`, and only after the user agreed that running it now should perform its real actions. Never set it to get past the refusal on your own.",
        },
      },
      required: ["adapterId"],
    },
  },
  {
    name: "discover_source_fields",
    description:
      "Sample the LIVE source through the built connector (a few rows, nothing landed in any table) and RECORD the source's actual field shape on the connector — names, inferred types, one example value each. Call it after a build_connector succeeds when the source's schema is unknown, or when adapter_dry_run shows missing required fields or surprising extras: the discovered shape is threaded into every later build_connector prompt automatically, so a repair maps the source's REAL fields instead of guessing. Returns the fields split into modelFields (land as columns) and extraFields (preserved in the row's _raw JSON at ingest). Sampling an `actuator` performs its action, so the platform refuses unless confirmActions is set — describe the source in `instructions` instead of discovering it there.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        confirmActions: {
          type: "boolean",
          description:
            "Only for an `actuator`, and only after the user agreed that sampling it now should perform its real actions.",
        },
      },
      required: ["adapterId"],
    },
  },
  {
    name: "fetch_docs",
    description:
      "Fetch one PUBLIC documentation web page (an API reference, developer guide, or schema description) and return its readable text. Call this BEFORE build_connector when you are unsure which endpoints, fields, auth scheme, or pagination a source system's API exposes — ground the build instructions in the vendor's real documentation instead of guessing, trying a few likely URLs if the first misses. HTTPS/HTTP to public hosts only (private and internal addresses are blocked); HTML is stripped to text and long pages are truncated.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The documentation page URL, e.g. https://developers.pipedrive.com/docs/api/v1" },
      },
      required: ["url"],
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
    name: "list_table_rows",
    description:
      "Read the CURRENT rows of a model table (entity or value object) in this workflow — read-only, the same data the explorer's Items pane shows. Returns the total row count plus up to `limit` rows. Use it to check whether a table is already populated (e.g. before simulating a downstream aggregate), to fetch real ids that another table's rows must reference, or to inspect the shape of existing data.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "The entity or value-object name (the table name in the explorer)." },
        limit: { type: "number", description: "Max rows to return (default 20, cap 100). The count is always the full total." },
      },
      required: ["table"],
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
        behavior: {
          type: "string",
          enum: ["sync", "generator", "actuator", "extractor"],
          description:
            "What running this connector COSTS. sync (default) = it mirrors a system of record; re-running is free. generator = it computes its rows (an AI call, a paid API per row); re-running costs money. actuator = it PERFORMS AN ACTION in another system (creates a record there, sends a message) and then lands the result; re-running changes the outside world. extractor = it reads an unstructured source (a document, a sheet) and interprets it with AI; re-running is safe but pays for the extraction again. If the connector will write anything anywhere, it is actuator — ASK the user to confirm that before creating, never infer it silently.",
        },
        targetSystem: {
          type: "string",
          description:
            "The PRODUCT this connector talks to (\"Slack\", \"HubSpot\", \"Stripe\"), when the bounded context is not already its name. Every warning names the system it is about to write to, and the bounded context is the MODEL's word for it — a Slack connector modelled under \"Notifications\" would otherwise warn about writing to \"Notifications\". There is no UI for this, so it is on you: set it whenever you can tell what the product is, which you usually can from the credential or the URL you were given. Omit when the bounded context IS the product name.",
        },
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
      "WRITE — Have AI write (or repair) the connector's integration code from a natural-language description of the source, then auto-install whatever npm packages the code imports. The connector may use ANY package or protocol (AWS SDK, pg, googleapis, fetch, soap…). Stop-and-show: it writes + registers the code but does NOT run or ingest — test it next with adapter_dry_run. When the connector COMPUTES its rows (per-row AI/API cost) rather than passing a source through, instructions must state the re-run behavior agreed with the user (incremental vs regenerate-all; per-period ids when the target links into a recurring cycle) — see the Re-run behavior ritual. To REPAIR a failed connector, pass errorReport (the error + trace from the failed adapter_dry_run) and it will rewrite the code to fix it. Requires confirmation: summarize what you'll build/fix, ask 'Shall I build it?', wait for yes, then call with confirmed:true.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        instructions: { type: "string", description: "Natural-language description of the source and how to read it (which table/endpoint/query, pagination, shape). REPLACES the stored instructions outright — it is not merged — and the code is re-authored from this text alone, so when the user asks for one more thing ('also filter to emails containing qlerify') you must resend the WHOLE brief with that added, never the new sentence on its own. Read the stored one back with get_adapter_config first if you did not write it yourself. On a repair turn omit it to reuse the last one." },
        errorReport: { type: "string", description: "On a repair turn: the error + redacted trace from the failed adapter_dry_run, so the AI can fix the code." },
        confirmed: { type: "boolean" },
      },
      required: ["adapterId", "confirmed"],
    },
  },
  {
    name: "build_trigger_rules",
    description:
      "WRITE — Have AI compile per-EVENT trigger rules for a connector: tiny deterministic predicates (from each event's Given/When/Then criteria + the operator's stated condition) that decide which domain event(s) an ingested row implies — replacing the platform's generic heuristics for exactly those events. Use when the operator states per-event conditions ('trigger Upsell Deal Created for upsell deals and Cross Sell Deal Created for cross sell deals') or one table drives sibling events that need discriminating. Compile the whole family of related events in ONE call so the conditions stay mutually consistent. Stop-and-show: rules are written + recorded, not executed — verify each with preview_trigger_rule next; if a preview is wrong or errors, call again with that report as errorReport (self-heal). Requires confirmation: state each event + its condition, ask 'Shall I compile these rules?', wait for yes, then call with confirmed:true.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        rules: {
          type: "array",
          description: "One entry per event to rule.",
          items: {
            type: "object",
            properties: {
              event: { type: "string", description: "Event name or key (must be an event on the connector's target table)." },
              condition: { type: "string", description: "The operator's natural-language condition for this event. Omit on a recompile to reuse the stored one." },
            },
            required: ["event"],
          },
        },
        errorReport: { type: "string", description: "On a self-heal turn (single rule): what the preview got wrong, or the ruleError, so the AI can fix the code." },
        confirmed: { type: "boolean" },
      },
      required: ["adapterId", "rules", "confirmed"],
    },
  },
  {
    name: "preview_trigger_rule",
    description:
      "Dry-run one trigger rule against the live rows (nothing is emitted): how many rows it fires for, which would emit now, and per-row evidence samples — the oracle to check after build_trigger_rules and before ingest_connector. If the result is wrong or carries a ruleError, fix it via build_trigger_rules with an errorReport.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        event: { type: "string", description: "Event name or key of the rule to preview." },
      },
      required: ["adapterId", "event"],
    },
  },
  {
    name: "ingest_connector",
    description:
      "WRITE — Run the connector for real and LAND its rows into the target table (gen_<kind>), so they appear in the explorer's Items pane. Do this after a successful adapter_dry_run — or, on an `actuator` where no dry run exists, as the FIRST run, since its pull is the action. Requires confirmation: state how many rows you'll pull into which table (for an actuator, what it will DO and where), ask 'Shall I populate it?', wait for yes, then call with confirmed:true.",
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
  {
    name: "set_connector_schedule",
    description:
      "WRITE — Turn a connector's scheduled polling on or off, set how often it runs, and set when it first runs. Use whenever the user asks to fetch/refresh/sync on a schedule ('poll this every 6 hours', 'run it nightly', 'stop polling'). everyMinutes is the interval in MINUTES (6 hours = 360, daily = 1440) and must be at least 5; convert the user's words yourself. Pass startAt whenever the user cares WHEN it runs, and always when connectors have to run in order: without it the clock is inherited from whenever that connector last ran, which is invisible to the user and almost never what they meant. To stagger a chain (A fills a table, B reads it), give each connector the same interval and startAt times spaced apart. Enabling means the connector runs unattended against the live source from then on, so it requires confirmation: state the interval AND the first run time you are about to set, ask 'Shall I turn that on?', wait for yes, then call with confirmed:true. Read the current schedule with get_adapter_config.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        enabled: { type: "boolean", description: "true starts scheduled polling, false stops it" },
        everyMinutes: { type: "number", description: "Interval in minutes, minimum 5. Required when enabling; ignored when disabling (the stored interval is kept)." },
        startAt: {
          type: "string",
          description: "When the first run should happen, as an ISO date/time (\"2026-08-21T12:00:00Z\"). Every later run sits on the grid startAt + n × everyMinutes, so gaps between staggered connectors keep their width instead of drifting. Resolve relative words like 'in 10 minutes' or 'tomorrow at 9' into an absolute time yourself. A time already past means run at the next tick. Pass an empty string to clear it and go back to counting from the last run.",
        },
        confirmed: { type: "boolean" },
      },
      required: ["adapterId", "enabled", "confirmed"],
    },
  },
  {
    name: "set_connector_behavior",
    description:
      "WRITE — Change what re-running an EXISTING connector costs: `sync` (mirrors a system of record, re-running is free), `generator` (computes each row at a real cost), `actuator` (PERFORMS AN ACTION in another system, then lands the result), `extractor` (interprets an unstructured source with AI). Use when the user says a connector was classified wrongly, or when its code has changed so that it now writes where it only read before — that reclassification is not automatic, so if you edit a connector into performing actions you must offer to retype it. Marking something `actuator` makes model rebuilds skip it and makes the read-only affordances refuse; marking it anything else REMOVES those protections. Requires confirmation: say what changes as a result, ask, wait for yes, then call with confirmed:true. Read the current type with get_adapter_config.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        behavior: { type: "string", enum: ["sync", "generator", "actuator", "extractor"] },
        targetSystem: {
          type: "string",
          description:
            "Optional. The PRODUCT it writes to (\"Slack\"), when the bounded context is the model's word rather than the product's. Pass an empty string to clear it.",
        },
        confirmed: { type: "boolean" },
      },
      required: ["adapterId", "behavior", "confirmed"],
    },
  },
  {
    name: "update_connector_description",
    description:
      "WRITE — Refresh the description shown on a connector's card so it says what the connector NOW does. Call it whenever you have changed what a connector does in a way a rebuild did not already cover — most often after set_connector_behavior, since retyping never re-describes and the old text keeps naming the old type. Omit `description` to have the AI re-read the connector's current code and config and write it (the normal case). Pass `description` only when the user dictates the wording. No confirmation needed: this changes documentation, never the code or the source system. Read the current description with get_adapter_config.",
    input_schema: {
      type: "object",
      properties: {
        adapterId: { type: "string" },
        description: {
          type: "string",
          description: "Optional. Exact wording to store. Omit to let the AI derive it from the connector's current code, which is what keeps filters and re-run behaviour accurate.",
        },
      },
      required: ["adapterId"],
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
      // Coerce EXACTLY like the handlers do (String(...)), so a non-string
      // adapterId (an array, a number) can't slip past the gate and reach a
      // foreign tenant's connector via the handler's own String() coercion.
      const idArg = args.adapterId == null ? "" : String(args.adapterId);
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
        return ok(await handleAdapterDryRun(String(args.adapterId ?? ""), Number(args.limit ?? 3), args.confirmActions === true));
      case "discover_source_fields":
        return await handleDiscoverSourceFields(String(args.adapterId ?? ""), args.confirmActions === true);
      case "fetch_docs":
        return ok(await fetchDocs(String(args.url ?? "")));
      case "regenerate_adapter_body":
        return await handleRegenerateAdapterBody(args);
      case "reset_adapter":
        return handleResetAdapter(args);
      case "list_model_kinds":
        return ok(handleListModelKinds(typeof args.boundedContext === "string" ? args.boundedContext : undefined));
      case "list_table_rows":
        return ok(await handleListTableRows(String(args.table ?? ""), Number(args.limit ?? 20)));
      case "create_connector":
        return handleCreateConnector(args);
      case "set_connector_credentials":
        return await handleSetConnectorCredentials(args);
      case "build_connector":
        return await handleBuildConnector(args);
      case "build_trigger_rules":
        return await handleBuildTriggerRules(args);
      case "preview_trigger_rule":
        return await handlePreviewTriggerRule(args);
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
      case "set_connector_schedule":
        return handleSetConnectorSchedule(args);
      case "set_connector_behavior":
        return handleSetConnectorBehavior(args);
      case "update_connector_description":
        return await handleUpdateConnectorDescription(args);
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
    select: { eventName: true, eventRef: true, boundedContext: true, role: true, businessAt: true, businessAtKind: true, occurredAt: true },
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
      behavior: adapterCfg(a.id)?.behavior ?? "sync",
    })),
  };
}

function handleGetAdapterConfig(adapterId: string) {
  if (!ownsAdapterId(adapterId)) return { error: `no adapter "${adapterId}"` }; // foreign ≡ unknown (no oracle)
  const cfg = adapterCfg(adapterId);
  if (!cfg) return { error: `no adapter "${adapterId}"` };
  return {
    id: cfg.id, kind: cfg.kind, boundedContext: cfg.boundedContext, targetEntity: cfg.targetEntity,
    behavior: cfg.behavior ?? "sync",
    targetSystem: cfg.targetSystem ?? null,
    mode: cfg.mode, endpoint: cfg.endpoint ?? null, credentialsRef: cfg.credentialsRef ?? null,
    // build_connector replaces this wholesale, so it must be readable to resend whole.
    instructions: cfg.instructions ?? null,
    description: readDoc(adapterId)?.summary ?? null,
    hasBody: !!cfg.bodyPath, bodyPath: cfg.bodyPath ?? null,
    schedule: cfg.schedule ?? null,
    nextRunAt: nextRunAt(cfg),
    lastPullAt: cfg.lastPullAt ?? null,
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

/** Sample the live source and record its observed field shape (orchestrate
 * discoverSourceFields). Defense-in-depth ownership recheck like the sibling
 * exec tools, on top of the TOOL_OWNED_ID gate. */
async function handleDiscoverSourceFields(adapterId: string, confirmActions?: boolean): Promise<ToolResult> {
  if (!adapterId) return err("adapterId required");
  if (!ownsAdapterId(adapterId)) return err(`no adapter "${adapterId}" in this workflow`); // foreign ≡ unknown (no oracle)
  return ok(await discoverSourceFields(adapterId, confirmActions));
}

async function handleAdapterDryRun(adapterId: string, limit: number, confirmActions?: boolean) {
  if (!ownsAdapterId(adapterId)) return { error: `no adapter "${adapterId}"` }; // foreign ≡ unknown (no oracle); also blocks cross-tenant exec
  const a = getAdapter(adapterId);
  if (!a) return { error: `no adapter "${adapterId}"` };
  const cfg = adapterCfg(adapterId);
  if (cfg) {
    try {
      assertActionsConfirmed(cfg, "a dry run", confirmActions);
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
  // Entity OR value object — VO targets are first-class (ingest and the /test
  // oracle resolve both), so their required/extras grading must work too.
  const entity = getOntology().entity(a.targetEntity) ?? getOntology().valueObject(a.targetEntity);
  try {
    const fieldMap = await a.mapping();
    const { rows } = await a.pull({ limit: limit > 0 ? limit : 3 });
    const mapped = (rows[a.targetEntity] ?? []).map((r) => applyFieldMap(r, fieldMap));
    const missingRequired = entity
      ? entity.required.filter((f) => mapped.length === 0 || mapped.some((r) => r[f] === undefined || r[f] === null || r[f] === ""))
      : [];
    // Source fields beyond the model — informational, not an error: ingest folds
    // them into the row's `_raw` JSON column (packs/ingest.ts), nothing is lost.
    const platformCols = new Set(store.PLATFORM_ROW_COLS);
    const extraFields = entity
      ? [...new Set(mapped.flatMap((r) => Object.keys(r).filter((k) => !platformCols.has(k))))].filter(
          (k) => !entity.fields.some((f) => f.name === k),
        )
      : [];
    return { ok: true, count: mapped.length, sample: mapped.slice(0, 2), missingRequired, extraFields };
  } catch (e: any) {
    // The error report the doctor reasons about (and can pass to regenerate).
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// Pre-flight guard for the AI-authoring tools. Org-aware: resolveAnthropicStatus
// reads the request-bound tenant context, so an org that configured its own key in
// Org Admin (BYOK) passes even when no platform ANTHROPIC_API_KEY is set. Checking
// process.env directly here would reject BYOK-only orgs before the org-aware
// getAnthropicClient() ever runs.
async function requireAnthropicConfigured(): Promise<ToolResult | null> {
  const status = await resolveAnthropicStatus();
  if (status.configured) return null;
  return err(
    "No AI provider configured — choose one in Org Admin → AI provider (an Anthropic API key, or AWS Bedrock with your own AWS credentials), or set the platform default in .env.",
  );
}

async function handleRegenerateAdapterBody(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Summarize the repair, get the user's explicit yes, then call again with confirmed=true.");
  }
  const adapterId = String(args.adapterId ?? "");
  if (!adapterId) return err("adapterId required");
  const noKey = await requireAnthropicConfigured();
  if (noKey) return noKey;
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

// Read-only look at a model table's current rows. Org- and workflow-scoped via
// the projection store, so it discloses exactly what the explorer's Items pane
// already shows the caller. The simulate-content doctrine leans on it: check
// whether an upstream table is populated before fabricating downstream rows, and
// fetch REAL ids for reference fields.
async function handleListTableRows(tableArg: string, limitArg: number) {
  const name = tableArg.trim();
  if (!name) return { error: "table required" };
  const o = getOntology();
  const kind = o.entity(name) ?? o.valueObject(name);
  if (!kind) return { error: `no entity or value object "${name}" in the model` };
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(Math.floor(limitArg), 100) : 20;
  const count = await store.countRows(kind.name);
  const rows = count === 0 ? [] : await store.findMany(kind.name, limit);
  // organization_id is a tenancy internal — never part of the business row.
  return { table: kind.name, count, rows: rows.map(({ organization_id: _org, ...r }) => r) };
}

function handleCreateConnector(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Confirm the system + target with the user first, then call again with confirmed=true.");
  }
  const boundedContext = String(args.boundedContext ?? "");
  const target = String(args.target ?? "");
  if (!boundedContext || !target) {
    return err("boundedContext and target are required");
  }
  const behavior = args.behavior;
  if (behavior !== undefined && !BEHAVIORS.has(behavior)) {
    return err(`behavior must be one of: ${[...BEHAVIORS].join(", ")}`);
  }
  const cfg = createConnector({
    boundedContext,
    target,
    id: typeof args.id === "string" ? args.id : undefined,
    behavior: behavior as AdapterBehavior | undefined,
    targetSystem: typeof args.targetSystem === "string" ? args.targetSystem : undefined,
  });
  return ok({
    created: true, adapterId: cfg.id, boundedContext: cfg.boundedContext, target: cfg.targetEntity, targetKind: cfg.targetKind,
    behavior: cfg.behavior,
    note: cfg.behavior === "actuator"
      ? "Connector created as an ACTUATOR: a model rebuild will NOT re-run it, because its pull performs real actions. Next: credentials if needed, then build_connector."
      : "Empty connector created. Next: if the source needs auth, collect the fields and call set_connector_credentials; then build_connector with a description of the source.",
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
  const noKey = await requireAnthropicConfigured();
  if (noKey) return noKey;
  const r = await buildConnector(
    id,
    typeof args.instructions === "string" ? args.instructions : undefined,
    typeof args.errorReport === "string" ? args.errorReport : undefined,
  );
  const acts = performsActions(adapterCfg(id));
  const nextStep = acts
    ? "Code written + packages installed. This connector performs actions, so there is NO dry run to try first — say plainly what the first run will DO and where, get a yes, then call ingest_connector."
    : "Code written + packages installed. Now TEST it with adapter_dry_run before ingesting. If it errors, call build_connector again with the errorReport to fix it.";
  return ok({
    built: true, adapterId: id, targetKind: r.targetKind, dependencies: r.deps, codeBytes: r.bytes, durationMs: r.durationMs,
    install: { ok: r.install.ok, installed: r.install.installed, skipped: r.install.skipped, ...(r.install.ok ? {} : { log: r.install.log }) },
    note: r.install.ok
      ? nextStep
      : "Code written but some npm packages failed to install (see install.log). The first run will likely fail until deps resolve.",
  });
}

async function handleBuildTriggerRules(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. State each event + its condition, get the user's explicit yes, then call again with confirmed=true.");
  }
  const id = String(args.adapterId ?? "");
  if (!id) return err("adapterId required");
  const rules = Array.isArray(args.rules) ? args.rules : [];
  if (rules.length === 0) return err("rules must be a non-empty array of { event, condition? }");
  const noKey = await requireAnthropicConfigured();
  if (noKey) return noKey;
  const errorReport = typeof args.errorReport === "string" && rules.length === 1 ? args.errorReport : undefined;
  const compiled: Array<Record<string, unknown>> = [];
  const failures: Array<{ event: string; error: string }> = [];
  // Sequential on purpose: each compile records its condition on the sidecar, so
  // later siblings in the same call see the earlier ones' conditions and the
  // family stays mutually consistent (upsell vs cross sell).
  for (const r of rules) {
    const eventArg = String(r?.event ?? "");
    if (!eventArg) {
      failures.push({ event: "(missing)", error: "each rule needs an event name or key" });
      continue;
    }
    try {
      const res = await compileTriggerRule(
        id, eventArg,
        typeof r?.condition === "string" ? r.condition : undefined,
        errorReport,
      );
      compiled.push({
        event: res.rule.eventKey, eventRef: res.rule.eventRef, condition: res.rule.condition,
        file: res.rule.file, bytes: res.bytes, durationMs: res.durationMs,
      });
    } catch (e: any) {
      failures.push({ event: eventArg, error: String(e?.message ?? e) });
    }
  }
  return ok({
    built: compiled.length, compiled, ...(failures.length ? { failures } : {}),
    note: compiled.length
      ? "Rules compiled + recorded. Now VERIFY each with preview_trigger_rule against the live rows before ingesting; if a preview is wrong, call build_trigger_rules again with an errorReport describing what fired that shouldn't (or vice versa)."
      : "No rules compiled — see failures.",
  });
}

async function handlePreviewTriggerRule(args: Record<string, any>) {
  const id = String(args.adapterId ?? "");
  const event = String(args.event ?? "");
  if (!id || !event) return err("adapterId and event are required");
  if (!ownsAdapterId(id)) return err(`no connector "${id}"`); // foreign ≡ unknown (no oracle); also blocks cross-tenant exec
  return ok(await previewRule(id, event));
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
    note: `Landed ${summary.inserted} new row(s)${summary.updated ? `, updated ${summary.updated}` : ""} (${summary.skipped} unchanged) into ${summary.entity} in ${(summary.durationMs / 1000).toFixed(1)}s. They now appear in the explorer's Items pane.${ev}`,
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

function handleSetConnectorSchedule(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Tell the user the interval you would set, get a yes, then call again with confirmed=true.");
  }
  const id = String(args.adapterId ?? "");
  if (!id) {
    return err("adapterId required");
  }
  if (typeof args.enabled !== "boolean") {
    return err("enabled must be true or false");
  }
  try {
    const schedule = setConnectorSchedule(id, {
      enabled: args.enabled, everyMinutes: args.everyMinutes,
      ..."startAt" in args ? { startAt: args.startAt } : {},
    });
    const cfg = adapterCfg(id);
    const at = cfg ? nextRunAt({ ...cfg, schedule }) : null;
    return ok({
      adapterId: id,
      schedule,
      nextRunAt: at,
      note: !schedule.enabled
        ? "Polling is off — the connector only runs when pulled manually."
        : schedule.startAt
          ? `Polling is on — first run ${schedule.startAt}, then every ${schedule.everyMinutes} minute(s) from that time. Later runs stay on that grid, so a gap you set between two connectors keeps its width.`
          : `Polling is on — this connector now runs every ${schedule.everyMinutes} minute(s), counted from its last run${at ? `, next ${at}` : ""}. Set startAt if it needs to land at a particular time.`,
    });
  } catch (e: any) {
    if (e instanceof ScheduleError) {
      return err(e.message);
    }
    throw e;
  }
}

function handleSetConnectorBehavior(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. Tell the user what changes when the type changes, get a yes, then call again with confirmed=true.");
  }
  const id = String(args.adapterId ?? "");
  if (!id) {
    return err("adapterId required");
  }
  const was = adapterCfg(id)?.behavior ?? "sync";
  try {
    const behavior = setConnectorBehavior(id, args.behavior);
    const targetSystem = typeof args.targetSystem === "string"
      ? setConnectorTargetSystem(id, args.targetSystem)
      : (adapterCfg(id)?.targetSystem ?? null);
    return ok({
      adapterId: id,
      was,
      behavior,
      targetSystem,
      note:
        behavior === "actuator"
          ? "Typed as an actuator: model rebuilds now skip it, and the dry-run and field-discovery tools refuse rather than performing its action. This changed what the PLATFORM does, not what the code does — code written for a read-only connector still lacks the actuator disciplines (check the other system before acting, bound actions by ctx.limit, export a read-only probe()). Tell the user, and offer a build_connector rebuild so its code matches its type."
          : was === "actuator"
            ? "No longer an actuator: model rebuilds will re-run it, and the dry-run and field-discovery tools will execute its code."
            : `Typed as ${behavior}.`,
    });
  } catch (e: any) {
    return err(e?.message ?? String(e));
  }
}

async function handleUpdateConnectorDescription(args: Record<string, any>) {
  const id = String(args.adapterId ?? "");
  if (!id) {
    return err("adapterId required");
  }
  if (!adapterCfg(id)) {
    return err(`no connector "${id}"`);
  }
  const dictated = typeof args.description === "string" ? args.description.trim() : "";
  if (dictated) {
    setConnectorSummary(id, dictated);
    appendNote(id, "note", "Description set by hand; it no longer necessarily matches the code.");
    return ok({
      adapterId: id,
      source: "dictated",
      description: readDoc(id)?.summary ?? null,
      note: "Stored the wording you were given. It will be replaced the next time the connector is built, repaired or re-described from its code.",
    });
  }
  const outcome = await regenerateConnectorSummary(id);
  return ok({
    adapterId: id,
    source: outcome === "described" ? "ai" : outcome,
    degraded: outcome !== "described",
    description: readDoc(id)?.summary ?? null,
    note: outcome === "described"
      ? "Re-read the connector's code and rewrote the description from it."
      : outcome === "fallback"
        ? "The AI describer was unavailable, so this is a generic one-liner, NOT a real description. Tell the user it could not be written rather than reading it back as though it were."
        : "Nothing was written: this connector's target table is not in the loaded model, so there was nothing to describe it against.",
  });
}
