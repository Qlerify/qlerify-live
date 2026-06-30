// Action → permission mapping (spec §6.4). The PDP never sees raw API actions;
// every action is mapped to a permission in the lattice first. Per §6.4, sharing
// and deletion MUST require `administer`, not `edit`.

import type { Permission } from "../types.js";

export const ACTION_PERMISSION_MAP: Record<string, Permission> = {
  // Ontology-as-resource (§16) — the resource increment 1 proves end-to-end.
  "ontology.read": "view",
  "ontology.edit": "edit",
  "ontology.write": "edit",
  "ontology.delete": "administer",
  "ontology.share": "administer",

  // Model lifecycle routes (formerly unauthenticated) act ON the ontology.
  "model.apply": "administer",
  "model.fetch": "administer",
  "model.roll": "administer",
  "model.restore": "administer",

  // Generic asset actions, for when more resource types land.
  "dataset.read": "view",
  "dataset.write": "edit",
  "dataset.delete": "administer",
  "dataset.share": "administer",
  "pipeline.run": "edit",

  // Data-plane actions (§6.4) — the per-workflow runtime: commands, the
  // simulator, chat write-tools, and connectors. Gated at the HTTP/chat boundary
  // via guardData(); the underlying generic functions stay PDP-free so direct
  // (non-request) callers — the sim runner, tests — are unaffected. Reads stay
  // membership-scoped (any org member), matching the dashboard read model.
  "workflow.read": "view",
  "workflow.command.write": "edit",
  "workflow.sim.write": "edit",
  "workflow.sim.administer": "administer", // destructive: reset / delete-all / reimport
  "connector.read": "view",                // view connector source / config (kill-switch-covered disclosure)
  // AUTHORING connector code is the RCE/SSRF/npm-install surface, so it requires
  // "special access" — for now that is org-admin/owner (administer). A finer
  // dedicated "connector-builder" grant can be layered on later without moving the
  // call sites. (Per the maintainer decision on F-17: per-org builders.)
  "connector.build": "administer",         // create connector / author or repair its code
  "connector.edit": "edit",                // repoint / credentials / ingest existing connectors
  "connector.administer": "administer",    // delete / reset

  // Scope administration.
  "organization.administer": "administer",
  "environment.deploy": "deploy",
};

export function actionToPermission(action: string): Permission {
  const p = ACTION_PERMISSION_MAP[action];
  if (!p) throw new Error(`unknown action "${action}" — add it to ACTION_PERMISSION_MAP`);
  return p;
}
