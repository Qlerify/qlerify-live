// Id + hash helpers and the platform's fixed sentinel identifiers.
//
// There is no longer a seeded "system" organization (the single-tenant demo it
// hosted was removed). What remains are pure SENTINEL CONSTANTS — they are NOT
// rows in the database:
//   - SYSTEM_ORG_ID      the off-request data-scope default (boot, fs.watch, the
//                        sim runner, tests, module-load) and the audit stream for
//                        context-less platform events (login, org deletion). No
//                        platOrganization row carries it.
//   - SYSTEM_WORKFLOW_ID the off-request / empty "system context" workflow
//                        sentinel (no platWorkflow row carries it) → the un-
//                        prefixed gen_ tables + the empty on-disk model.
//   - SYSTEM_STACK_ID    the single local stack every pooled org shares.
// Fixed, valid-v4-shaped UUIDs so the values are stable and recognizable.

import { randomUUID, createHash } from "node:crypto";

export const SYSTEM_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const SYSTEM_WORKFLOW_ID = "00000000-0000-4000-8000-000000000006";
export const SYSTEM_STACK_ID = "local";

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
