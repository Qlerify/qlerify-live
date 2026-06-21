// Deterministic introspection of the Qlerify model for command code generation.
//
// Turns each domain event's bound command into a CommandDescriptor carrying
// everything the emitter needs: handler/route/file names (derived purely by
// casing rules), the typed argument list (recovered from the command schema and,
// where the command is type-poor, name-matched against the aggregate entity's
// fields), the emitting role, the Given/When/Then, and content hashes used for
// drift detection. Pure read over getOntology(); no file I/O, no AI. This is the
// deterministic-scaffold half of the seam (ARCHITECTURE.md §2/§3/§6).

import { createHash } from "node:crypto";
import { getOntology } from "../../ontology/model.js";

export interface FieldDesc {
  name: string;
  tsType: string;
  validator: string | null; // require* helper name, or null if untyped/optional
  required: boolean;
}

export interface CommandDescriptor {
  commandName: string; // OrderMaterial
  handlerName: string; // orderMaterial
  kebab: string; // order-material
  boundedContext: string; // SAP
  bcDir: string; // sap
  aggregate: string; // PurchaseOrder
  aggDir: string; // purchase-order
  dir: string; // src/sap/purchase-order
  eventRef: string; // #/domainEvents/MaterialOrdered
  eventName: string; // Material Ordered
  role: string; // Buyer
  fields: FieldDesc[];
  required: string[];
  acceptanceCriteria: string[];
  gwtHash: string;
  schemaHash: string;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function camelCase(pascal: string): string {
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// Pascal/acronym-aware kebab: "ConfirmOrderWithETA" -> "confirm-order-with-eta".
export function kebabCase(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

const TYPE_TO_VALIDATOR: Record<string, { tsType: string; validator: string | null }> = {
  string: { tsType: "string", validator: "requireString" },
  number: { tsType: "number", validator: "requirePositiveInt" },
  integer: { tsType: "number", validator: "requirePositiveInt" },
  boolean: { tsType: "boolean", validator: null },
};

function recover(dataType?: string) {
  return TYPE_TO_VALIDATOR[(dataType ?? "string").toLowerCase()] ?? TYPE_TO_VALIDATOR.string;
}

/** All commands declared by events in a bounded context, as descriptors. */
export function descriptorsForBoundedContext(bc: string): CommandDescriptor[] {
  const ont = getOntology();
  const out: CommandDescriptor[] = [];
  const seen = new Set<string>();

  for (const ev of ont.events) {
    if (ev.boundedContext !== bc || !ev.commandName) continue;
    if (seen.has(ev.commandName)) continue;
    seen.add(ev.commandName);

    const cmd = ont.command(ev.commandName);
    if (!cmd) continue;
    const entity = ont.entity(ev.aggregateRoot);
    const entityType = new Map((entity?.fields ?? []).map((f) => [f.name, f.dataType]));

    const required = cmd.required ?? [];
    const fieldNames = cmd.fields.length ? cmd.fields.map((f) => f.name) : required;
    const fields: FieldDesc[] = fieldNames.map((name) => {
      const cmdField = cmd.fields.find((f) => f.name === name);
      // Type recovery: prefer the command field's own dataType; fall back to the
      // aggregate entity's same-named field (commands are often type-poor).
      const dataType = cmdField?.dataType ?? entityType.get(name);
      const isRequired = required.includes(name);
      const { tsType, validator } = recover(dataType);
      return { name, tsType, validator: isRequired ? validator : null, required: isRequired };
    });

    const bcDir = bc.toLowerCase();
    const aggDir = kebabCase(ev.aggregateRoot);

    out.push({
      commandName: ev.commandName,
      handlerName: camelCase(ev.commandName),
      kebab: kebabCase(ev.commandName),
      boundedContext: bc,
      bcDir,
      aggregate: ev.aggregateRoot,
      aggDir,
      dir: `src/${bcDir}/${aggDir}`,
      eventRef: ev.ref,
      eventName: ev.name,
      role: ev.role,
      fields,
      required,
      acceptanceCriteria: ev.acceptanceCriteria ?? [],
      gwtHash: sha256(ev.acceptanceCriteria ?? []),
      schemaHash: sha256({ required: cmd.required ?? [], fields: cmd.fields ?? [] }),
    });
  }

  return out;
}
