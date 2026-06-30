// The actor-kind ALS — the "HOW" half of event attribution (the "WHO" is the
// principal on the tenant context). Carried in its own AsyncLocalStorage, parallel
// to the tenant context, so the single emit() chokepoint can record *which surface*
// drove a write without threading a flag through every command/sim/chat signature.
//
// Resolution (currentActorKind):
//   - an explicit withActorKind(...) scope wins (the chat turn sets "ai", a data
//     derivation sets "adapter");
//   - otherwise a BOUND request is a human-driven HTTP call → "human";
//   - otherwise (boot, fs.watch, the sim runner, module-load, tests) → "system".
//
// This mirrors the withScope pattern in events/bus.ts: a withX wrapper whose
// binding propagates across awaits inside the callback.

import { AsyncLocalStorage } from "node:async_hooks";
import { tenantContext } from "./context.js";

/** The surface that drove a state change. `human` = a person on the HTTP API;
 * `ai` = the chat assistant's write tools; `adapter` = data-evidence derivation;
 * `system` = off-request machinery (boot, sim runner, tests). */
export type ActorKind = "human" | "ai" | "system" | "adapter";

const als = new AsyncLocalStorage<ActorKind>();

/** Run `fn` with the actor kind pinned (restored after). Wrap the chat tool loop
 * with "ai" and data derivation with "adapter"; everything else inherits the
 * default below. */
export function withActorKind<T>(kind: ActorKind, fn: () => Promise<T>): Promise<T> {
  return als.run(kind, fn);
}

/** The actor kind for the current execution — explicit scope, else human
 * on-request, else system off-request. Never throws. */
export function currentActorKind(): ActorKind {
  const explicit = als.getStore();
  if (explicit) return explicit;
  return tenantContext() ? "human" : "system";
}
