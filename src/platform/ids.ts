// Id + hash helpers and the fixed identifiers of the seeded "system" tenant.
//
// The system organization is how the existing single-tenant demo keeps running
// once tenancy exists: every non-request context (boot, the fs.watch reload, the
// simulator runner, tests, module-load) resolves to the system org, so the demo
// flows THROUGH the tenant spine instead of around it (no TENANCY=off bypass).
// Its ids are fixed (not random) so seeding is idempotent and code can reference
// the system org/identity deterministically.

import { randomUUID, createHash } from "node:crypto";
import type { Principal } from "./types.js";

// Fixed, valid-v4-shaped UUIDs for the seeded system tenant.
export const SYSTEM_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const SYSTEM_CUSTOMER_ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";
export const SYSTEM_IDENTITY_ID = "00000000-0000-4000-8000-000000000003";
export const SYSTEM_ENV_ID = "00000000-0000-4000-8000-000000000004"; // "development"
export const SYSTEM_WORKSPACE_ID = "00000000-0000-4000-8000-000000000005";
export const SYSTEM_PROJECT_ID = "00000000-0000-4000-8000-000000000006";
export const SYSTEM_ONTOLOGY_RESOURCE_ID = "00000000-0000-4000-8000-000000000007";
export const SYSTEM_ONTOLOGY_ID = "00000000-0000-4000-8000-000000000008";
export const SYSTEM_STACK_ID = "local";
export const SYSTEM_SUBJECT = "system";

/** The principal the demo / non-request contexts act as. */
export const SYSTEM_PRINCIPAL: Principal = { id: SYSTEM_IDENTITY_ID, type: "identity" };

export function newId(): string {
  return randomUUID();
}

/** sha256 hex digest — the content-addressing primitive (§ storage design). */
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** URL/identifier-safe slug for an organization name. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "org";
}
