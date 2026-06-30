// Workflow-scoped connector management (the "Connectors" tab). A PROJECTION over
// the connector sidecars + journal + projection store — no new source of truth.
// Three operations, all scoped to the ACTIVE workflow:
//   GET  /api/connectors            — inventory (active + orphaned) + the re-point picker
//   POST /api/connectors/:id/repoint — change which table a connector populates (I1-guarded)
//   POST /api/connectors/:id/delete  — full teardown (code + creds + data + events + history)
//
// "Orphaned" = the connector's target table no longer exists in the live model
// (renamed away or deleted). Such a connector can't ingest (the host throws), so
// this tab is its only home and the place to re-point or delete it. Re-point is the
// deliberate manual substitute for automatic rename detection (no stable entity ids).

import type { FastifyInstance } from "fastify";
import { isHandledError } from "../errors.js";
import { getOntology } from "../ontology/model.js";
import { currentWorkflowId } from "../platform/tenancy/context.js";
import {
  connectorsInWorkflow, connectorForTarget, connectorOwner, connectorInfo,
  regenerateConnectorSummary, removeConnector, setConnectorDateRoles,
} from "../packs/connector/orchestrate.js";
import { resolveTargetSchema, createConnectorAdapter } from "../packs/adapters/connector.js";
import { registerAdapter } from "../packs/registry.js";
import { writeSidecar } from "../packs/sidecar.js";
import { readDoc, appendNote } from "../packs/connector/journal.js";
import { tableExists, countRows } from "../twin/projection-store.js";
import { purgeEntityData } from "../twin/purge.js";
import { guardData } from "../platform/authz.js";

export function registerConnectorRoutes(app: FastifyInstance): void {
  // Inventory for the active workflow + the available tables (with occupancy) the
  // re-point picker needs.
  app.get("/api/connectors", async (req, reply) => {
    try {
      const wf = currentWorkflowId();
      const o = getOntology();
      const cfgs = connectorsInWorkflow(wf);
      const connectors = await Promise.all(cfgs.map(async (cfg) => {
        const info = connectorInfo(cfg.id);
        const doc = readDoc(cfg.id);
        const live = !!resolveTargetSchema(cfg.targetEntity);
        const rowCount = (await tableExists(cfg.targetEntity)) ? await countRows(cfg.targetEntity) : 0;
        return {
          id: cfg.id,
          boundedContext: cfg.boundedContext,
          targetEntity: cfg.targetEntity,
          targetKind: cfg.targetKind ?? "entity",
          mode: cfg.mode,
          phase: cfg.phase,
          status: live ? "active" : "orphaned",
          hasCode: info?.hasCode ?? false,
          credentialKeys: info?.credentialKeys ?? [],
          deps: cfg.deps ?? [],
          endpoint: cfg.endpoint ?? null,
          summary: doc?.summary ?? null,
          notes: (doc?.notes ?? []).slice(-6),
          lastPullAt: cfg.lastPullAt ?? null,
          rowCount,
          owned: !!cfg.workflowId, // false = legacy, adopted by model membership
          dateRoles: info?.dateRoles ?? null,
          dateFields: info?.dateFields ?? [],
        };
      }));
      // The re-point target list: every table in the model, flagged with the
      // connector (if any) already populating it in this workflow.
      const tables = [
        ...o.entities.map((e) => ({ name: e.name, kind: "entity" as const })),
        ...o.valueObjects.map((v) => ({ name: v.name, kind: "valueObject" as const })),
      ].map((t) => ({ ...t, occupiedBy: connectorForTarget(t.name, wf)?.id ?? null }));
      return { connectors, tables };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Re-point a connector at a different table. Going FORWARD only: existing rows in
  // the old table are left as-is (source/target schemas differ — moving them is a
  // data-loss trap); the connector feeds the new table on the next Fetch. I1-guarded:
  // the new table must not already have a connector in this workflow.
  app.post("/api/connectors/:id/repoint", async (req, reply) => {
    try {
      await guardData("connector.edit");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const target = String((req.body as any)?.target ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      if (!target) return reply.code(400).send({ error: "NO_TARGET", message: "target required" });
      if (target === cfg.targetEntity) return reply.code(400).send({ error: "NO_CHANGE", message: `connector already targets "${target}"` });
      if (!resolveTargetSchema(target)) return reply.code(400).send({ error: "UNKNOWN_TARGET", message: `"${target}" is not a table in the model` });
      const occupant = connectorForTarget(target, wf, id);
      if (occupant) return reply.code(409).send({ error: "TABLE_OCCUPIED", message: `"${target}" is already populated by connector "${occupant.id}". Delete it first, then re-point.` });
      const targetKind: "entity" | "valueObject" = getOntology().entity(target) ? "entity" : "valueObject";
      const previous = cfg.targetEntity;
      const owner = connectorOwner();
      const next = {
        ...cfg, targetEntity: target, targetKind,
        workflowId: cfg.workflowId ?? owner.workflowId,
        organizationId: cfg.organizationId ?? owner.organizationId,
      };
      writeSidecar(next);
      registerAdapter(createConnectorAdapter(next));
      await regenerateConnectorSummary(id); // table + access changed → refresh the description
      appendNote(id, "repointed", `Re-pointed from ${previous} to ${target}.`);
      return { id, target, previousTarget: previous, targetKind };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Override which source columns hold the record's creation / last-modified times.
  // Consumed by twin/derive.ts to stamp create vs update events with real dates.
  // Field names are validated against the target schema; null/empty clears a role.
  app.post("/api/connectors/:id/date-roles", async (req, reply) => {
    try {
      await guardData("connector.edit");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      const body = (req.body as any) ?? {};
      const dateRoles = setConnectorDateRoles(id, { created: body.created ?? null, updated: body.updated ?? null });
      return { id, dateRoles };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      if (err instanceof Error && /is not a field/.test(err.message)) {
        return reply.code(400).send({ error: "BAD_FIELD", message: err.message });
      }
      throw err;
    }
  });

  // Delete one connector completely — code + credentials + config + registry entry +
  // history, AND the data it produced (target table rows + derived events). Workflow-
  // scoped and bc-independent, so it works even for an orphan whose system is also gone.
  app.post("/api/connectors/:id/delete", async (req, reply) => {
    try {
      await guardData("connector.administer");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      const { rows, events } = await purgeEntityData(cfg.targetEntity);
      removeConnector(id);
      return { id, entity: cfg.targetEntity, deletedRows: rows, deletedEvents: events, removed: true };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });
}
