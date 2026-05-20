// Pluggable role-based auth. Default impl reads the current role from the
// x-role HTTP header (or AUTH_ROLE env var as fallback for the simulator runner).
// Swap with JWT/OAuth by replacing assertRole — handler code doesn't change.

import { AuthError } from "./errors.js";
import type { FastifyRequest } from "fastify";

export type Role =
  | "Product Manager"
  | "Designer"
  | "Configuration Manager"
  | "Planner"
  | "Supply Planner"
  | "Buyer"
  | "Supplier"
  | "Production Planner"
  | "Goods Receiving"
  | "Production"
  | "Test Engineer"
  | "Quality Engineer"
  | "Warehouse"
  | "Logistics"
  | "Customer"
  | "Automation";

const ALL_ROLES: ReadonlyArray<Role> = [
  "Product Manager", "Designer", "Configuration Manager", "Planner",
  "Supply Planner", "Buyer", "Supplier", "Production Planner",
  "Goods Receiving", "Production", "Test Engineer", "Quality Engineer",
  "Warehouse", "Logistics", "Customer", "Automation",
];

export function roleFromRequest(req: FastifyRequest): Role {
  const headerRole = (req.headers["x-role"] || "").toString();
  const envRole = process.env.AUTH_ROLE || "";
  const candidate = headerRole || envRole;
  if (!candidate) throw new AuthError("missing x-role header");
  if (!ALL_ROLES.includes(candidate as Role)) {
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
