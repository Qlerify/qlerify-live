// Runtime registry of generated commands, keyed by HTTP route segment (kebab).
//
// Populated by the generated, side-effect-only module registry.generated.ts,
// which is imported once at server startup (src/http/routes.ts). Backs the
// /commands/:bc/:name/describe and /commands/:bc/:name/detect endpoints without
// the HTTP layer having to know which commands exist — it asks the registry.

import type { DetectInput, DetectResult } from "./runtime.js";

export interface CommandRegistration {
  commandName: string; // OrderMaterial
  boundedContext: string; // SAP
  handlerName: string; // orderMaterial
  eventRef: string; // #/domainEvents/MaterialOrdered
  role: string; // Buyer
  detect: (input: DetectInput) => Promise<DetectResult>;
  DESCRIBE: string;
}

const registry = new Map<string, CommandRegistration>();

export function register(routeSegment: string, reg: CommandRegistration): void {
  registry.set(routeSegment, reg);
}

export function getCommandByRoute(routeSegment: string): CommandRegistration | undefined {
  return registry.get(routeSegment);
}

export function listRegisteredCommands(): CommandRegistration[] {
  return [...registry.values()];
}
