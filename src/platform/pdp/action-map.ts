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

  // Scope administration.
  "organization.administer": "administer",
  "environment.deploy": "deploy",
};

export function actionToPermission(action: string): Permission {
  const p = ACTION_PERMISSION_MAP[action];
  if (!p) throw new Error(`unknown action "${action}" — add it to ACTION_PERMISSION_MAP`);
  return p;
}
