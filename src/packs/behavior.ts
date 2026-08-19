import { DomainError } from "../errors.js";
import type { AdapterBehavior, AdapterConfig } from "./types.js";

type BehaviorOf = Pick<AdapterConfig, "behavior">;
type Named = Pick<AdapterConfig, "boundedContext" | "targetSystem">;
type GateTarget = Pick<AdapterConfig, "id" | "boundedContext" | "targetSystem" | "behavior">;

export const performsActions = (cfg: BehaviorOf | null | undefined): boolean => cfg?.behavior === "actuator";

/** What to CALL the system a connector talks to. The bounded context is the
 * model's word for it, which is often the process step rather than the product —
 * a Slack connector modelled under "Notifications" must still warn about writing
 * to Slack. */
export const systemName = (cfg: Named): string => cfg.targetSystem?.trim() || cfg.boundedContext;

const VERB: Record<AdapterBehavior, string> = {
  sync: "reads a system of record",
  generator: "computes each row at a real cost",
  actuator: "performs actions in another system",
  extractor: "interprets an unstructured source with AI",
};

export const behaviorVerb = (behavior?: AdapterBehavior): string => VERB[behavior ?? "sync"];

/** Refuse to run an actuator's code for a read-shaped reason. An actuator's
 * fetchRows IS the action, so a dry run, a test and field discovery all create
 * records for real — there is no read-only variant to fall back to. */
export function assertActionsConfirmed(cfg: GateTarget, what: string, confirmed: boolean | undefined): void {
  if (!performsActions(cfg) || confirmed) {
    return;
  }
  throw new DomainError(
    `"${cfg.id}" performs actions in ${systemName(cfg)}, so ${what} would create records there for real — ` +
      `an actuator has no read-only pull. Verify the connection to check it is reachable, or confirm the actions to run it on purpose.`,
  );
}
