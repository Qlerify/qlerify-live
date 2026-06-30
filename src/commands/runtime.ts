// Kernel runtime contract for generated commands.
//
// A command is split into two files joined across this typed seam:
//   - {command}.gen.ts   deterministic skeleton (auth + validation + wiring),
//                         regenerated from the Qlerify model;
//   - {command}.logic.ts  the AI/hand-authored region exporting apply/detect/DESCRIBE.
//
// The skeleton calls apply(ctx) across CommandContext, so the business logic
// never touches Fastify or the model loader and can be regenerated on its own.
// detect() is the "has this event happened?" predicate the vision asks for; it is
// shared between the command precondition story and Part-5 storyline reconstruction.

import type { Role } from "../auth.js";

export interface CommandContext<TArgs = Record<string, unknown>> {
  args: TArgs;
  role: Role;
  /** The exact domain event this invocation should record, e.g.
   * "#/domainEvents/ApprovalProcessCompleted2". Set by callers that step through
   * EVENTS rather than commands (the simulator): several events can share one
   * command, so the command name alone is ambiguous — without this the generic
   * base binds to the FIRST event for the command and a later same-command event
   * would re-emit the earlier one (wedging a stepped run). Omitted on the plain
   * command path (an HTTP command POST names no event), which keeps the existing
   * first-event-by-command behavior. */
  eventRef?: string;
}

/** Input to an event-detection predicate. For now: the aggregate id. */
export interface DetectInput {
  id: string;
}

export interface DetectResult {
  /** Whether the bound domain event appears to have occurred for this aggregate. */
  happened: boolean;
  /** Human-readable justification (what state was read to decide). */
  evidence: string;
}

