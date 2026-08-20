// Connector adapter HOST (Part 2.4) — wraps a full-power AI-built connector behind
// the standard SourceAdapter contract, so ingestPull, the /test dry-run, and the
// explorer all consume it unchanged. The difference from the Part 2.3 authored
// adapter: the body is unrestricted and runs in an ISOLATED child process (see
// connector/runtime), not in-process. The target may be an entity OR a value
// object — value objects become their own gen_<VO> table when populated directly.

import { prisma } from "../../db.js";
import { getOntology, type EntitySchema } from "../../ontology/model.js";
import { eventLogOrgWhere } from "../../platform/tenancy/event-scope.js";
import type { AdapterConfig, SourceAdapter } from "../types.js";
import { runConnector, moduleExists, SNAPSHOT_ROWS_PER_TABLE, SNAPSHOT_EVENT_ROWS, SNAPSHOT_EVENT_BYTES, type EventsSnapshot } from "../connector/runtime.js";
import { readSidecar } from "../sidecar.js";
import * as store from "../../twin/projection-store.js";

/** Resolve the connector's target schema — an entity, or a value object. */
export function resolveTargetSchema(name: string): EntitySchema | undefined {
  const o = getOntology();
  return o.entity(name) ?? o.valueObject(name);
}

/** Read-only copies of every populated projection table in the loaded model
 * (entities and value objects), keyed by logical name — the ctx.readTable
 * snapshot. Earlier events routinely shape what a connector must pull (e.g. one
 * Insights row per Quarter company), so every pull gets the whole workflow's
 * data. COPIES only: they travel via the ctx file into the sandboxed child,
 * which still has no path to the real tables. */
export async function collectWorkflowTables(): Promise<Record<string, Array<Record<string, unknown>>>> {
  const o = getOntology();
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const e of [...o.entities, ...o.valueObjects]) {
    if (out[e.name] || !(await store.tableExists(e.name))) continue;
    const rows = await store.findMany(e.name, SNAPSHOT_ROWS_PER_TABLE);
    out[e.name] = rows.map(({ organization_id: _org, ...rest }) => rest);
  }
  return out;
}

function parsePayload(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** Read-only copy of the workflow's domain-event log — the ctx.readEvents
 * snapshot. Events are the truthful "did upstream step X happen for case Y"
 * signal a reactive connector triggers from, and each row carries caseId +
 * aggregateId so produced rows can copy their case linkage straight off the
 * triggering event. COPIES via the ctx file, like collectWorkflowTables. The
 * NEWEST rows win the cap, and truncation is flagged — never silent — because a
 * clipped log must not read as "those events never happened". Note the log is
 * wiped + rebuilt (fresh ids/timestamps) on every model apply, so the module
 * doctrine is: trigger from events, gate "already handled" on own output rows.
 * During that rebuild (reingestAll pulls first, derives once at the end) this
 * snapshot is EMPTY — an event-reactive connector then correctly returns [] and
 * repopulates on its next run after derive; delayed, never duplicated. */
export async function collectWorkflowEvents(): Promise<EventsSnapshot> {
  const recent = await prisma.eventLog.findMany({
    where: eventLogOrgWhere(),
    orderBy: { occurredAt: "desc" },
    take: SNAPSHOT_EVENT_ROWS + 1,
    select: {
      eventName: true, eventRef: true, boundedContext: true, aggregateRoot: true,
      aggregateId: true, caseId: true, occurredAt: true, businessAt: true,
      provenance: true, actorKind: true, payload: true,
    },
  });
  const overRowCap = recent.length > SNAPSHOT_EVENT_ROWS;
  const capped = overRowCap ? recent.slice(0, SNAPSHOT_EVENT_ROWS) : recent;
  // Byte budget on top of the row cap: payloads dominate, and 10k fat ones
  // would balloon the ctx file. Newest-first, so the newest rows win here too;
  // always keep at least one row.
  let bytes = 0;
  const kept: typeof capped = [];
  for (const e of capped) {
    bytes += e.payload.length + 256; // 256 ≈ the fixed columns' share per row
    if (kept.length > 0 && bytes > SNAPSHOT_EVENT_BYTES) break;
    kept.push(e);
  }
  const truncated = overRowCap || kept.length < capped.length;
  const rows = kept.reverse().map((e) => ({
    ...e,
    occurredAt: e.occurredAt.toISOString(),
    businessAt: e.businessAt?.toISOString() ?? null,
    payload: parsePayload(e.payload),
  }));
  return { rows, truncated };
}

export function createConnectorAdapter(cfg: AdapterConfig): SourceAdapter {
  function target(): EntitySchema {
    const e = resolveTargetSchema(cfg.targetEntity);
    if (!e) throw new Error(`connector "${cfg.id}": target "${cfg.targetEntity}" is not in the loaded model`);
    return e;
  }

  return {
    id: cfg.id,
    kind: "connector",
    boundedContext: cfg.boundedContext,
    targetEntity: cfg.targetEntity,
    mode: cfg.mode ?? "live",
    async introspect() {
      // The SOURCE's discovered shape when a discovery sample has run
      // (orchestrate discoverSourceFields — fresh-read so a sample taken after
      // registration is picked up); the model schema as the fallback echo.
      const discovered = readSidecar(cfg.id)?.discoveredFields;
      if (discovered?.length) {
        return { entity: cfg.targetEntity, fields: discovered.map((f) => ({ name: f.name, dataType: f.dataType, sample: f.sample })) };
      }
      const e = target();
      return { entity: e.name, fields: e.fields.map((f) => ({ name: f.name, dataType: f.dataType, sample: f.exampleData?.[0] })) };
    },
    async mapping() {
      return cfg.fieldMap ?? {};
    },
    async pull(opts = {}) {
      const e = target();
      // null = uncapped (pull everything); only an OMITTED limit falls back.
      const limit = opts.limit === null ? null : opts.limit ?? cfg.limits?.limit ?? 25;
      const r = await runConnector(cfg.id, {
        entity: e,
        limit,
        endpoint: cfg.endpoint,
        tables: await collectWorkflowTables(),
        events: await collectWorkflowEvents(),
      });
      if (!r.ok) {
        const trace = r.trace?.length ? `\nTrace:\n${r.trace.slice(-12).join("\n")}` : "";
        throw new Error(`${r.error ?? "connector run failed"}${trace}`);
      }
      const arr = limit == null ? r.rows ?? [] : (r.rows ?? []).slice(0, limit);
      return { rows: { [e.name]: arr }, count: arr.length };
    },
    async push() {
      return { pushed: 0 };
    },
    async healthcheck() {
      try {
        if (!moduleExists(cfg.id)) return { ok: false, detail: "no connector code yet — build it first" };
        const e = target();
        // An actuator's fetchRows performs its action, and healthcheck runs on
        // every connector detail read — so it must never be the fallback here.
        const r = await runConnector(cfg.id, { entity: e, limit: 1, op: "probe", probeOnly: cfg.behavior === "actuator" });
        if (r.probe) return r.probe;
        if (!r.ok) return { ok: false, detail: r.error };
        return { ok: true, detail: `reached the source, fetched ${r.count ?? r.rows?.length ?? 0} row(s)` };
      } catch (err: any) {
        return { ok: false, detail: err?.message ?? String(err) };
      }
    },
  };
}
