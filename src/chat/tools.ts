// Tools exposed to the LLM. Each maps onto an existing internal handler or
// a small read against the DB / event log. Write tools (next_step,
// create_demand) require an explicit `confirmed: true` argument — that check
// is enforced both in the tool handler here AND in the system prompt's
// confirmation policy.

import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db.js";
import { EVENTS } from "../events/registry.js";
import { STEP_DURATIONS_HOURS, businessTimeForStep } from "../events/clock.js";
import { currentStepIndex, nextStep, newDemand } from "../simulator/stepper.js";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_demands",
    description:
      "List every demand currently in the simulator with its lifecycle status, progress (X of 28 steps), and dwellSeconds (real wall-clock idleness since the last event). Use this whenever the user asks 'how many demands are…', 'which demands…', 'show me all demands', or needs an overview.",
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
      "Resolve a human description of a demand to a demandId. Matches against customer id, product name, qty, requested week, or any combination. Returns one or more matching demand summaries. Use this when the user references a demand by description (e.g. 'the Baseband one for cust-22', '8 × Radio Unit X').",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text description, e.g. '8 baseband cust-22' or 'radio unit x'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_demand_details",
    description:
      "Return the full per-demand state: the Demand row, its Project, BuildPlan(s), Build, BomItems, EngineeringRelease, PurchaseOrders, etc. Use when the user asks 'what's the state of X' or wants to see specific fields on a demand's aggregates.",
    input_schema: {
      type: "object",
      properties: {
        demandId: { type: "string", description: "The demand id, e.g. 'dmd-339c7c25'." },
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
      "Return the canonical definition of a single step in the 28-event workflow — name, bounded context, role, derived flag, acceptance criteria, and expected duration from the previous step in business days. Use when the user asks 'what does step N do', 'what gates X', 'how long should Y take'.",
    input_schema: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "1-based step number (1..28). Step 1 is Hardware Demand Created.",
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
      "WRITE — Advance a demand one step forward in the workflow. Requires explicit user confirmation: summarize what will happen, ask 'Shall I proceed?', wait for an explicit yes, then call with `confirmed: true`. The tool refuses with an error if `confirmed` is false.",
    input_schema: {
      type: "object",
      properties: {
        demandId: { type: "string" },
        withDisruptions: {
          type: "boolean",
          description:
            "Whether disruption steps (ETA slip, shortage, replan) should fire. Default true — preserves the Cascading-Disruptions storyline.",
        },
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
      "WRITE — Create a new demand using the next demand template in rotation. Requires explicit user confirmation: summarize what will be created (the template's customer + product + qty + week), ask 'Shall I proceed?', wait for yes, then call with `confirmed: true`.",
    input_schema: {
      type: "object",
      properties: {
        confirmed: { type: "boolean" },
      },
      required: ["confirmed"],
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
  const demands = await prisma.demand.findMany({ orderBy: { createdAt: "desc" } });
  const now = Date.now();
  const out = [];
  for (const d of demands) {
    const lastEvent = await prisma.eventLog.findFirst({
      where: { demandId: d.id },
      orderBy: { occurredAt: "desc" },
      select: { eventName: true, eventRef: true, occurredAt: true, businessAt: true },
    });
    const progress = await prisma.eventLog.findMany({
      where: { demandId: d.id },
      distinct: ["eventRef"],
      select: { eventRef: true },
    });
    const dwellSeconds = lastEvent ? Math.round((now - new Date(lastEvent.occurredAt).getTime()) / 1000) : null;
    const row = {
      id: d.id,
      customerId: d.customerId,
      productName: d.productName,
      qty: d.qty,
      requestedWeek: d.requestedWeek,
      status: d.status,
      progress: progress.length,
      total: EVENTS.length,
      lastEventName: lastEvent?.eventName ?? null,
      lastBusinessAt: lastEvent?.businessAt ?? null,
      dwellSeconds,
    };
    if (olderThanSeconds == null || (dwellSeconds ?? 0) >= olderThanSeconds) {
      out.push(row);
    }
  }
  return { demands: out, count: out.length, threshold: olderThanSeconds ?? null };
}

async function handleFindDemand(query: string) {
  const q = query.toLowerCase().trim();
  if (!q) return { matches: [] };
  const demands = await prisma.demand.findMany();
  const matches = demands.filter((d) => {
    const blob = `${d.id} ${d.customerId} ${d.productName} ${d.qty} ${d.requestedWeek} ${d.status}`.toLowerCase();
    return q.split(/\s+/).every((tok) => blob.includes(tok));
  });
  return { query, matches: matches.map((d) => ({ id: d.id, customer: d.customerId, product: d.productName, qty: d.qty, week: d.requestedWeek, status: d.status })) };
}

async function handleGetDemandDetails(demandId: string) {
  const demand = await prisma.demand.findUnique({ where: { id: demandId } });
  if (!demand) return { error: `no demand ${demandId}` };
  const project = await prisma.project.findFirst({
    where: { demandId },
    include: { bomItems: true },
  });
  const plans = await prisma.buildPlan.findMany({
    where: { demandId },
    orderBy: { versionNo: "desc" },
    include: { builds: { include: { buildDemand: true } } },
  });
  const er = project ? await prisma.engineeringRelease.findUnique({ where: { projectId: project.id } }) : null;
  const ecs = project ? await prisma.engineeringChange.findMany({ where: { projectId: project.id } }) : [];
  const pos = project ? await prisma.purchaseOrder.findMany({ where: { projectId: project.id } }) : [];
  const buildIds = plans.flatMap((p) => p.builds.map((b) => b.id));
  const bookings = await prisma.lineBooking.findMany({ where: { buildId: { in: buildIds } } });
  const tests = await prisma.testResult.findMany({ where: { buildId: { in: buildIds } } });
  const units = await prisma.unit.findMany({ where: { buildId: { in: buildIds } } });
  const shipments = await prisma.shipment.findMany({ where: { demandId }, include: { units: true } });
  return { demand, project, plans, engineeringRelease: er, engineeringChanges: ecs, purchaseOrders: pos, lineBookings: bookings, tests, units, shipments };
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
  const dur = STEP_DURATIONS_HOURS[i] ?? 0;
  return {
    step: index1Based,
    name: e.name,
    ref: e.ref,
    boundedContext: e.boundedContext,
    aggregateRoot: e.aggregateRoot,
    role: e.role,
    phase: e.phase,
    derived: !!e.derived,
    durationHoursFromPrev: dur,
    expectedBusinessTime: businessTimeForStep(i).toISOString(),
  };
}

async function handleGetCurrentStep(demandId: string) {
  const idx = await currentStepIndex(demandId);
  if (idx >= EVENTS.length) return { demandId, done: true, completedSteps: EVENTS.length };
  const e = EVENTS[idx]!;
  return {
    demandId,
    nextStep: idx + 1,
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
  const withDisruptions = args.withDisruptions !== false;
  const result = await nextStep(demandId, withDisruptions);
  return ok({
    stepFired: result.index + 1,
    eventName: result.event.name,
    boundedContext: result.event.boundedContext,
    role: result.event.role,
    caption: result.caption,
    done: result.done,
  });
}

async function handleCreateDemand(args: Record<string, any>) {
  if (args.confirmed !== true) {
    return err("write tool refused: confirmed=false. You must obtain an explicit user confirmation first, then call again with confirmed=true.");
  }
  const result = await newDemand();
  return ok({ demandId: result.id, template: result.template });
}
