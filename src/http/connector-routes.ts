// Workflow-scoped connector management (the "Connectors" tab). A PROJECTION over
// the connector sidecars + journal + projection store — no new source of truth.
// All operations are scoped to the ACTIVE workflow:
//   GET  /api/connectors             — inventory (active + orphaned) + the re-point picker
//   GET  /api/connectors/export      — portable backup of every connector (download)
//   GET  /api/connectors/:id/export  — portable backup of one connector (download)
//   POST /api/connectors/import      — recreate connectors from an export envelope
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
  readConnectorCode, saveConnectorCode, eventsForTarget,
} from "../packs/connector/orchestrate.js";
import { resolveTargetSchema, createConnectorAdapter } from "../packs/adapters/connector.js";
import { registerAdapter } from "../packs/registry.js";
import { writeSidecar } from "../packs/sidecar.js";
import { ScheduleError, nextRunAt, setConnectorSchedule } from "../packs/scheduler.js";
import { readDoc, appendNote } from "../packs/connector/journal.js";
import { saveTriggerRuleCode, deleteTriggerRule, previewRule, ruleStatus } from "../packs/connector/rules.js";
import { compileTriggerRule } from "../packs/connector/rules-codegen.js";
import { readRuleFile, deleteRuleFiles } from "../packs/connector/runtime.js";
import { buildConnectorExport } from "../packs/connector/export.js";
import { parseConnectorExport, importConnectors } from "../packs/connector/import.js";
import { tableExists, countRows } from "../twin/projection-store.js";
import { purgeEntityData } from "../twin/purge.js";
import { guardData } from "../platform/authz.js";

/** `attachment; filename="<stem>-YYYY-MM-DD.json"` — stem sanitized so a hostile
 * connector id can't inject header syntax into Content-Disposition. */
function exportDisposition(stem: string): string {
  const safe = stem.replace(/[^A-Za-z0-9._-]/g, "_");
  const date = new Date().toISOString().slice(0, 10);
  return `attachment; filename="${safe}-${date}.json"`;
}

// --- Structured manifest ----------------------------------------------------
// The connector overview's "what does this connector actually do" answer, as
// DYNAMICALLY-SHAPED sections: only what applies to this connector appears. A
// pure projection over the sidecar + journal facets + model + rule records —
// no new source of truth (this file's charter).

type ManifestSection =
  | { kind: "credentials"; keys: string[] }
  | { kind: "endpoint"; endpoint: string }
  | { kind: "packages"; deps: string[] }
  | { kind: "filters"; items: string[] }
  | { kind: "incremental"; behavior: string }
  | { kind: "timestamps"; created?: string; updated?: string }
  | { kind: "schedule"; enabled: boolean; everyMinutes?: number; nextRunAt?: string | null }
  | {
      kind: "canTriggerEvents";
      items: Array<{
        eventKey: string;
        eventName: string;
        /** The rule's compiled-from condition; null = static heuristic. */
        condition: string | null;
        status: "ok" | "stale" | "error" | "disabled" | "orphaned" | "static";
        statusDetail?: string;
        builtAt?: string;
        author?: "ai" | "human";
        /** Set on satellite events (they complete with their predecessor and
         * can never carry a rule of their own). */
        coupledTo?: string;
      }>;
    };

async function buildConnectorManifest(cfg: import("../packs/types.js").AdapterConfig) {
  const o = getOntology();
  const info = connectorInfo(cfg.id);
  const doc = readDoc(cfg.id);
  const live = !!resolveTargetSchema(cfg.targetEntity);
  const rowCount = (await tableExists(cfg.targetEntity)) ? await countRows(cfg.targetEntity) : 0;
  const sections: ManifestSection[] = [];
  const keys = info?.credentialKeys ?? [];
  if (keys.length) sections.push({ kind: "credentials", keys });
  if (cfg.endpoint) sections.push({ kind: "endpoint", endpoint: cfg.endpoint });
  if ((cfg.deps ?? []).length) sections.push({ kind: "packages", deps: cfg.deps! });
  if (doc?.facets?.filters?.length) sections.push({ kind: "filters", items: doc.facets.filters });
  if (doc?.facets?.incremental) sections.push({ kind: "incremental", behavior: doc.facets.incremental });
  if (cfg.dateRoles?.created || cfg.dateRoles?.updated) {
    sections.push({ kind: "timestamps", ...cfg.dateRoles });
  }
  if (cfg.schedule) {
    sections.push({
      kind: "schedule",
      enabled: cfg.schedule.enabled,
      everyMinutes: cfg.schedule.everyMinutes,
      nextRunAt: nextRunAt(cfg),
    });
  }
  // EVERY event rooted on the target, ruled or not — the overview answers "what
  // can this connector trigger" completely, with the heuristic-covered events
  // shown as "static" so an authored rule's absence is a visible default, not
  // a blind spot. Only for live entity targets (events root on entities).
  if (live && (cfg.targetKind ?? "entity") === "entity") {
    const ruleByKey = new Map((cfg.triggerRules ?? []).map((r) => [r.eventKey, r]));
    const items = eventsForTarget(cfg.targetEntity).map((e) => {
      const rule = ruleByKey.get(e.key);
      if (!rule) {
        return {
          eventKey: e.key,
          eventName: e.name,
          condition: null,
          status: "static" as const,
          ...(e.coupledTo ? { coupledTo: e.coupledTo } : {}),
        };
      }
      const st = ruleStatus(rule, o, cfg);
      return {
        eventKey: e.key,
        eventName: e.name,
        condition: rule.condition || null,
        status: st.status,
        ...(st.detail ? { statusDetail: st.detail } : {}),
        builtAt: rule.builtAt,
        author: rule.author,
      };
    });
    // An orphaned rule's event is gone from the model, so eventsForTarget missed
    // it — surface it anyway (never silently dropped).
    for (const rule of cfg.triggerRules ?? []) {
      if (items.some((i) => i.eventKey === rule.eventKey)) continue;
      const st = ruleStatus(rule, o, cfg);
      items.push({
        eventKey: rule.eventKey,
        eventName: rule.eventKey,
        condition: rule.condition || null,
        status: st.status,
        ...(st.detail ? { statusDetail: st.detail } : {}),
        builtAt: rule.builtAt,
        author: rule.author,
      });
    }
    if (items.length) sections.push({ kind: "canTriggerEvents", items });
  }
  return {
    id: cfg.id,
    system: cfg.boundedContext,
    target: { name: cfg.targetEntity, kind: cfg.targetKind ?? ("entity" as const), rowCount },
    mode: cfg.mode,
    phase: cfg.phase,
    status: live ? "active" : "orphaned",
    summary: doc?.summary ?? null,
    sections,
  };
}

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
          lastPullDurationMs: cfg.lastPullDurationMs ?? null,
          schedule: cfg.schedule ?? null,
          nextRunAt: nextRunAt(cfg),
          rowCount,
          owned: !!cfg.workflowId, // false = legacy, adopted by model membership
          dateRoles: info?.dateRoles ?? null,
          dateFields: info?.dateFields ?? [],
          triggerRules: (cfg.triggerRules ?? []).map((r) => ({
            eventKey: r.eventKey,
            eventName: o.eventByKey(r.eventKey)?.name ?? r.eventKey,
            condition: r.condition,
            builtAt: r.builtAt,
            author: r.author,
            ...ruleStatus(r, o, cfg),
          })),
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

  // Portable backup of EVERY connector in the active workflow, as a downloadable
  // versioned envelope (see packs/connector/export.ts for what's included and
  // what's deliberately stripped). Secrets never leave: credential field NAMES
  // only. `connector.read` — config + code is the same kill-switch-covered
  // disclosure surface as the /code GET. An empty workflow yields a valid empty
  // envelope (an empty backup is not an error). No /:id conflict: Fastify's
  // router prefers the static "export" segment over a param.
  app.get("/api/connectors/export", async (req, reply) => {
    try {
      await guardData("connector.read");
      const wf = currentWorkflowId();
      reply.header("Content-Disposition", exportDisposition("qlerify-connectors"));
      return buildConnectorExport(connectorsInWorkflow(wf));
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Same envelope with a single entry. Workflow-scoped: foreign and unknown ids
  // get the identical 404 (no cross-tenant existence oracle).
  app.get("/api/connectors/:id/export", async (req, reply) => {
    try {
      await guardData("connector.read");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      reply.header("Content-Disposition", exportDisposition(`qlerify-connector-${id}`));
      return buildConnectorExport([cfg]);
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Restore/share counterpart of export: recreate the envelope's connectors in
  // the ACTIVE workflow, per-entry (one conflict doesn't sink the file — see
  // packs/connector/import.ts for the skip/rename policy). `connector.build`:
  // imported code runs in the connector sandbox, so this IS the RCE surface,
  // exactly like saving hand-edited code. bodyLimit raised above the 1MB
  // default: an envelope bundles whole connector modules.
  app.post("/api/connectors/import", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    try {
      await guardData("connector.build");
      let envelope;
      try {
        envelope = parseConnectorExport(req.body);
      } catch (e) {
        return reply.code(400).send({ error: "BAD_ENVELOPE", message: (e as Error).message });
      }
      return await importConnectors(envelope);
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
      // Trigger rules were compiled for the OLD table's events + field shape;
      // they are meaningless on the new table (derive would disable them, and
      // every read surface would otherwise disagree). Drop them with the target —
      // rules die with their table binding, exactly as they die with the connector.
      const droppedRules = cfg.triggerRules ?? [];
      const next = {
        ...cfg, targetEntity: target, targetKind,
        workflowId: cfg.workflowId ?? owner.workflowId,
        organizationId: cfg.organizationId ?? owner.organizationId,
      };
      delete next.triggerRules;
      // The discovery sample has the same table binding as the rules: it was
      // taken against the OLD target's output shape, and a stale sample would
      // poison every later build prompt + introspect(). Drop it; the operator
      // re-runs discover_source_fields against the new target.
      const droppedDiscovery = !!cfg.discoveredFields?.length;
      delete next.discoveredFields;
      delete next.discoveredAt;
      writeSidecar(next);
      for (const r of droppedRules) deleteRuleFiles(id, r.eventKey);
      registerAdapter(createConnectorAdapter(next));
      await regenerateConnectorSummary(id); // table + access changed → refresh the description
      const ruleNote = droppedRules.length ? ` ${droppedRules.length} trigger rule(s) were dropped (they belonged to ${previous}'s events).` : "";
      const discoveryNote = droppedDiscovery ? ` The discovered source-field sample was dropped — re-run discovery against the new target.` : "";
      appendNote(id, "repointed", `Re-pointed from ${previous} to ${target}.${ruleNote}${discoveryNote}`);
      return { id, target, previousTarget: previous, targetKind, droppedRules: droppedRules.length };
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

  // The connector's current source — for the Code tab's editor. `connector.read` is
  // kill-switch-covered disclosure; workflow scoping (404 for a foreign/unknown id)
  // is the tenant boundary, same pattern as repoint/date-roles/delete.
  app.get("/api/connectors/:id/code", async (req, reply) => {
    try {
      await guardData("connector.read");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      const info = connectorInfo(id);
      return { id, code: readConnectorCode(id) ?? "", hasCode: info?.hasCode ?? false, deps: cfg.deps ?? [], phase: cfg.phase };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Save operator-edited connector code. This code runs in the connector sandbox, so
  // hand-authoring it IS the RCE surface — gated by `connector.build` (the same
  // capability as AI build/repair), not the lighter `connector.edit`. Stop-and-show:
  // writes the module + installs whatever it now imports + re-registers the adapter,
  // but does NOT run or ingest — the operator tests it next (Test / Fetch).
  app.post("/api/connectors/:id/code", async (req, reply) => {
    try {
      await guardData("connector.build");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const code = (req.body as any)?.code;
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      if (typeof code !== "string") return reply.code(400).send({ error: "NO_CODE", message: "code (string) required" });
      const result = await saveConnectorCode(id, code);
      return { id, ...result };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // The structured manifest behind the overview's dynamic sections (Credentials /
  // Filters / Can trigger Events / …). `connector.read` — same disclosure class
  // as the inventory + code routes.
  app.get("/api/connectors/:id/manifest", async (req, reply) => {
    try {
      await guardData("connector.read");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      return await buildConnectorManifest(cfg);
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Per-event trigger rules — the authored evidence kind (packs/connector/rules).
  // Same scoping discipline as the code routes: workflow-scoped 404, read gated
  // by `connector.read`, writes by `connector.build` (rule code runs in-process
  // at derive time — authoring it is the same trust surface as connector code),
  // preview by `connector.edit` (it EXECUTES the rule read-only, like /test).
  // -------------------------------------------------------------------------

  // Every rule on this connector, with live health (ok/stale/error/disabled/
  // orphaned — computed against the current model on every read).
  app.get("/api/connectors/:id/rules", async (req, reply) => {
    try {
      await guardData("connector.read");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      const o = getOntology();
      return {
        id,
        rules: (cfg.triggerRules ?? []).map((r) => ({
          eventKey: r.eventKey,
          eventRef: r.eventRef,
          eventName: o.eventByKey(r.eventKey)?.name ?? r.eventKey,
          condition: r.condition,
          builtAt: r.builtAt,
          author: r.author,
          codeHash: r.codeHash,
          ...ruleStatus(r, o, cfg),
        })),
      };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/api/connectors/:id/rules/:eventKey/code", async (req, reply) => {
    try {
      await guardData("connector.read");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const eventKey = String((req.params as any).eventKey ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      const rule = (cfg.triggerRules ?? []).find((r) => r.eventKey === eventKey);
      if (!rule) return reply.code(404).send({ error: "UNKNOWN_RULE", message: `no rule for event "${eventKey}"` });
      const o = getOntology();
      return {
        id,
        eventKey,
        eventName: o.eventByKey(eventKey)?.name ?? eventKey,
        condition: rule.condition,
        builtAt: rule.builtAt,
        author: rule.author,
        code: readRuleFile(rule.file) ?? "",
        ...ruleStatus(rule, o, cfg),
      };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Save rule code (hand-edit, or a new rule authored straight in the editor).
  // Stop-and-show like connector code: written + recorded, not executed — the
  // operator previews it next.
  app.post("/api/connectors/:id/rules/:eventKey/code", async (req, reply) => {
    try {
      await guardData("connector.build");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const eventKey = String((req.params as any).eventKey ?? "");
      const code = (req.body as any)?.code;
      const condition = (req.body as any)?.condition;
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      if (typeof code !== "string") return reply.code(400).send({ error: "NO_CODE", message: "code (string) required" });
      const result = saveTriggerRuleCode(id, eventKey, code, {
        author: "human",
        ...(typeof condition === "string" && condition.trim() ? { condition: condition.trim() } : {}),
      });
      return { id, ...result };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // AI-recompile the rule from its STORED condition against the CURRENT model —
  // the stale badge's one-click fix (a fresh gwtHash clears the staleness).
  // `connector.build`, like every path that authors rule code.
  app.post("/api/connectors/:id/rules/:eventKey/recompile", async (req, reply) => {
    try {
      await guardData("connector.build");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const eventKey = String((req.params as any).eventKey ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      if (!(cfg.triggerRules ?? []).some((r) => r.eventKey === eventKey)) {
        return reply.code(404).send({ error: "UNKNOWN_RULE", message: `no rule for event "${eventKey}"` });
      }
      const condition = (req.body as any)?.condition;
      const r = await compileTriggerRule(id, eventKey, typeof condition === "string" && condition.trim() ? condition.trim() : undefined);
      return { id, ...r };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Dry-run the rule against the live rows (nothing emitted): fired/wouldEmitNow
  // counts + per-row evidence samples — the oracle the operator (and the build
  // flow) checks before ingesting.
  app.post("/api/connectors/:id/rules/:eventKey/preview", async (req, reply) => {
    try {
      await guardData("connector.edit");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const eventKey = String((req.params as any).eventKey ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      return { id, ...(await previewRule(id, eventKey)) };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Remove one rule — the event's static heuristic answers again from the next
  // derive. `connector.build`: it changes what authored code runs.
  app.post("/api/connectors/:id/rules/:eventKey/delete", async (req, reply) => {
    try {
      await guardData("connector.build");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const eventKey = String((req.params as any).eventKey ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });
      const removed = deleteTriggerRule(id, eventKey);
      return { id, eventKey, removed: true, condition: removed.condition };
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // `connector.build` because a schedule only changes WHEN already-authorised
  // code runs.
  app.post("/api/connectors/:id/schedule", async (req, reply) => {
    try {
      await guardData("connector.build");
      const wf = currentWorkflowId();
      const id = String((req.params as any).id ?? "");
      const cfg = connectorsInWorkflow(wf).find((c) => c.id === id);
      if (!cfg) return reply.code(404).send({ error: "UNKNOWN_CONNECTOR", message: `no connector "${id}" in this workflow` });

      const body = (req.body ?? {}) as { enabled?: unknown; everyMinutes?: unknown };
      try {
        return { id, schedule: setConnectorSchedule(id, { enabled: body.enabled === true, everyMinutes: body.everyMinutes }) };
      } catch (e) {
        if (e instanceof ScheduleError) {
          return reply.code(400).send({ error: "BAD_INTERVAL", message: e.message });
        }
        throw e;
      }
    } catch (err) {
      if (isHandledError(err)) return reply.code(err.status).send({ error: err.code, message: err.message });
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
