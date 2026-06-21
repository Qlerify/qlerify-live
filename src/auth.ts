// Pluggable role-based auth. Default impl reads the current role from the
// x-role HTTP header (or AUTH_ROLE env var as fallback for the simulator runner).
// Swap with JWT/OAuth by replacing assertRole — handler code doesn't change.

import { AuthError } from "./errors.js";
import type { FastifyRequest } from "fastify";
import { getOntology } from "./ontology/model.js";

// Roles are model-derived: the valid set is whatever the live ontology declares
// (getOntology().roles), so swapping the model swaps the roles with zero code
// change. The type is therefore an open `string` rather than a hardcoded union;
// the runtime guard below — and the conformance test — enforce that every role
// in play actually exists in the model.
export type Role = string;

export function roleFromRequest(req: FastifyRequest): Role {
  const headerRole = (req.headers["x-role"] || "").toString();
  const envRole = process.env.AUTH_ROLE || "";
  const candidate = headerRole || envRole;
  if (!candidate) throw new AuthError("missing x-role header");
  if (!getOntology().roles.includes(candidate)) {
    throw new AuthError(`unknown role: ${candidate}`);
  }
  return candidate as Role;
}

export function assertRole(actual: Role, allowed: Role | readonly Role[]) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(actual)) {
    throw new AuthError(`role "${actual}" not permitted; expected one of: ${list.join(", ")}`);
  }
}
