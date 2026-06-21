// Codegen drift detection. Compares the per-command hashes recorded at
// generation time (.qlerify/codegen.commands.json) against the live model, so the
// app can show which generated commands are current vs. need regeneration after a
// model hot-reload. Read-only — surfaces drift, never auto-applies (mirrors
// registry.ts/registryError discipline).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { QLERIFY_DIR, getOntology } from "../../ontology/model.js";

const MANIFEST = join(QLERIFY_DIR, "codegen.commands.json");

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type CommandStatus = "current" | "gwt-drift" | "schema-drift" | "missing-in-model";

export interface CommandStatusRow {
  command: string;
  route: string;
  status: CommandStatus;
  logicAuthor: string;
  generatedAt: string;
}

export function codegenStatus(): { ok: boolean; error?: string; commands: CommandStatusRow[] } {
  if (!existsSync(MANIFEST)) return { ok: false, error: "no .qlerify/codegen.commands.json", commands: [] };

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  const ont = getOntology();
  const rows: CommandStatusRow[] = Object.entries(manifest.commands ?? {}).map(([command, rec]: [string, any]) => {
    const ev = ont.events.find((e) => e.commandName === command);
    const cmd = ont.command(command);
    let status: CommandStatus = "current";
    if (!ev || !cmd) {
      status = "missing-in-model";
    } else if (sha256(ev.acceptanceCriteria ?? []) !== rec.gwtHash) {
      status = "gwt-drift";
    } else if (sha256({ required: cmd.required ?? [], fields: cmd.fields ?? [] }) !== rec.schemaHash) {
      status = "schema-drift";
    }
    return { command, route: rec.route, status, logicAuthor: rec.logicAuthor, generatedAt: rec.generatedAt };
  });

  return { ok: rows.every((r) => r.status === "current"), commands: rows };
}
