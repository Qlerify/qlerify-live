// Per-event trigger rules (the authored evidence kind). A rule is a tiny PURE,
// SYNCHRONOUS, zero-import ESM module — one per (connector, event) — that
// replaces the kernel's static evidence heuristic for exactly that event:
//
//   export function detect(row, ctx, previous /* reserved, null */) {
//     return { fired: amount > 20000 && /upsell/i.test(String(row.category)),
//              evidence: `amount=${amount} (>20000), category=${row.category}` };
//   }
//
// Persistence + loading follow the proven connector-body machinery: the module
// lives in the connector workspace under a CONTENT-HASH filename (tsx caches by
// path — a new version is a new path), is deny-scanned at write time AND load
// time, and is lazily imported in-process — justified over the child-process
// sandbox because a rule is a pure predicate called per-row in a hot loop (up to
// 10k rows × events), and its deny posture (zero imports, no fetch/fs/env) is
// STRICTER than the authored-body case that already runs in-process.
//
// Ownership is the connector's (sidecar `triggerRules`): a rule is a build
// artifact of (the event's GWTs × this connector's field shape) and dies with
// the connector. The GWTs in the model remain the durable truth — drift between
// the compiled-from hash and the live model is surfaced as "stale" (the rule
// still runs; drift is never auto-applied), and an event that vanished from the
// model turns its rule "orphaned" (skipped VISIBLY, never silently dropped).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getOntology, type EntitySchema, type Ontology, type OntologyEvent } from "../../ontology/model.js";
import {
  deriveFromData, type AuthoredRuleFn, type AuthoredRuleSet, type RuleContext, type RuleReport,
} from "../../twin/derive.js";
import { periodOf, periodStart } from "../../twin/period.js";
import * as store from "../../twin/projection-store.js";
import { connectorsEnabled } from "../../config/features.js";
import { DomainError, NotFoundError } from "../../errors.js";
import { denyScan } from "../codegen/deny-scan.js";
import { readSidecar, writeSidecar } from "../sidecar.js";
import { connectorsInWorkflow, connectorOwner } from "./orchestrate.js";
import { appendNote } from "./journal.js";
import { writeRuleFile, readRuleFile, deleteRuleFiles, ruleAbsPath, SNAPSHOT_ROWS_PER_TABLE } from "./runtime.js";
import type { AdapterConfig, TriggerRule } from "../types.js";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** The gwtHash convention: what a rule records at compile time and what the live
 * model is hashed to for drift detection. */
export function gwtHashOf(event: OntologyEvent): string {
  return sha256(JSON.stringify(event.acceptanceCriteria ?? []));
}

// Rule-specific denies ON TOP of the base adapter deny-scan. A rule runs
// IN-PROCESS (derive's hot loop), so this list is the boundary — and a regex
// gate is only as good as its coverage of escape primitives. A rule is a PURE
// predicate over row + ctx: it legitimately needs none of the reflection /
// global-reachability / dynamic-eval surface, so we ban those IDENTIFIERS
// outright (word-boundary, which also catches bracket access like
// `process["env"]` and constructor-escapes like `({}).constructor("…")` — the
// token still appears). This is deliberately stricter than the shared adapter
// deny-scan: the authored-HTTP-body tier has a wider legitimate surface, a rule
// does not. (A determined sync infinite loop still blocks the event loop — see
// the trust-boundary note on runPass; that is the connector.build capability's
// responsibility, the same as an authored body's sync section.)
const RULE_DENY: Array<{ re: RegExp; why: string }> = [
  { re: /\bimport\b/, why: "imports (a rule is a self-contained pure module)" },
  { re: /\bexport\s+[^;{]*\bfrom\b/, why: "re-exports" },
  { re: /\bfetch\s*\(/, why: "network (fetch)" },
  { re: /\bXMLHttpRequest\b/, why: "network (XMLHttpRequest)" },
  { re: /\bWebSocket\b/, why: "network (WebSocket)" },
  { re: /\bawait\b|\basync\b/, why: "async (detect must be synchronous)" },
  // Reflection / global reachability — the sandbox-escape primitives.
  { re: /\bprocess\b/, why: "process (env, mainModule, exit — no host reach)" },
  { re: /\bglobalThis\b/, why: "globalThis" },
  { re: /\bglobal\b/, why: "global" },
  { re: /\brequire\b/, why: "require()" },
  { re: /\bFunction\b/, why: "Function constructor (dynamic eval)" },
  { re: /\bconstructor\b/, why: "constructor access (constructor-escape)" },
  { re: /\bReflect\b/, why: "Reflect" },
  { re: /\bProxy\b/, why: "Proxy" },
  { re: /\bBuffer\b/, why: "Buffer" },
  { re: /\bmainModule\b/, why: "process.mainModule" },
  { re: /__proto__|\bprototype\b/, why: "prototype access (pollution / escape)" },
];

interface RuleScanResult {
  ok: boolean;
  violations: string[];
}

/** Static gate for rule source: the base deny-scan (fs/process/eval/…), the
 * rule-specific denies, and the required synchronous `export function detect`. */
export function ruleScan(code: string): RuleScanResult {
  const base = denyScan(code);
  const violations = [...base.violations];
  for (const { re, why } of RULE_DENY) if (re.test(code)) violations.push(why);
  if (!/\bexport\s+(?:function|const|let|var)\s+detect\b/.test(code)) {
    violations.push("missing `export function detect(row, ctx, previous)`");
  }
  return { ok: violations.length === 0, violations };
}

/** Resolve an event by key or (case-insensitive) name. */
export function resolveRuleEvent(ont: Ontology, keyOrName: string): OntologyEvent | undefined {
  const wanted = String(keyOrName).trim();
  return (
    ont.eventByKey(wanted) ??
    ont.events.find((e) => e.name.toLowerCase() === wanted.toLowerCase()) ??
    ont.events.find((e) => e.key.toLowerCase() === wanted.toLowerCase())
  );
}

/** Validate that `event` is one this connector's rules may bind: an event rooted
 * on the connector's own (entity) table, and not a coupled satellite (those
 * mirror their predecessor and never evaluate a predicate of their own). */
export function assertRuleBindable(cfg: AdapterConfig, event: OntologyEvent): void {
  if ((cfg.targetKind ?? "entity") === "valueObject") {
    throw new DomainError(`"${cfg.targetEntity}" is a value object — trigger rules bind to events on an entity table`);
  }
  if (event.aggregateRoot !== cfg.targetEntity) {
    throw new DomainError(
      `event "${event.name}" is rooted on ${event.aggregateRoot}, not this connector's table ${cfg.targetEntity}`,
    );
  }
  if (event.coupledTo) {
    throw new DomainError(`event "${event.name}" completes with its coupled predecessor — it cannot carry its own rule`);
  }
}

export interface SaveTriggerRuleResult {
  rule: TriggerRule;
  /** True when the content already existed under this hash (idempotent write). */
  skipped: boolean;
}

/** Persist a rule module (AI-compiled or hand-edited) and upsert its sidecar
 * record. The single write path: deny-scan → content-hash file → fresh-read
 * sidecar → journal. `condition` is kept from the existing record when omitted
 * (a hand-edit refines the code, not the intent). */
export function saveTriggerRuleCode(
  id: string,
  eventKeyOrName: string,
  code: string,
  opts: { author: "ai" | "human"; condition?: string },
): SaveTriggerRuleResult {
  const cfg = readSidecar(id);
  if (!cfg) throw new NotFoundError(`no connector "${id}"`);
  if (typeof code !== "string" || !code.trim()) throw new DomainError("rule code must be a non-empty string");
  const ont = getOntology();
  const event = resolveRuleEvent(ont, eventKeyOrName);
  if (!event) throw new DomainError(`no event "${eventKeyOrName}" in the loaded model`);
  assertRuleBindable(cfg, event);
  const scan = ruleScan(code);
  if (!scan.ok) throw new DomainError(`rule rejected by the deny-scan: ${scan.violations.join(", ")}`);
  const written = writeRuleFile(id, event.key, code);
  // Fresh read before write (the buildConnector discipline): don't clobber a
  // lastPullAt or another rule written while this one was being authored.
  const fresh = readSidecar(id) ?? cfg;
  const prev = (fresh.triggerRules ?? []).find((r) => r.eventKey === event.key);
  const rule: TriggerRule = {
    eventKey: event.key,
    eventRef: event.ref,
    condition: opts.condition ?? prev?.condition ?? "",
    gwtHash: gwtHashOf(event),
    file: written.file,
    codeHash: written.codeHash,
    builtAt: new Date().toISOString(),
    author: opts.author,
  };
  const rest = (fresh.triggerRules ?? []).filter((r) => r.eventKey !== event.key);
  writeSidecar({ ...fresh, triggerRules: [...rest, rule] });
  appendNote(
    id,
    "rule",
    `${opts.author === "ai" ? "Compiled" : "Hand-edited"} trigger rule for "${event.name}"${rule.condition ? ` — ${rule.condition}` : ""} (${code.length} bytes).`,
  );
  return { rule, skipped: written.skipped };
}

/** Remove one event's rule: record + every content-hash file version. The event
 * falls back to its static evidence heuristic on the next derive. */
export function deleteTriggerRule(id: string, eventKey: string): TriggerRule {
  const cfg = readSidecar(id);
  if (!cfg) throw new NotFoundError(`no connector "${id}"`);
  const rule = (cfg.triggerRules ?? []).find((r) => r.eventKey === eventKey);
  if (!rule) throw new NotFoundError(`connector "${id}" has no rule for event "${eventKey}"`);
  deleteRuleFiles(id, eventKey);
  writeSidecar({ ...cfg, triggerRules: (cfg.triggerRules ?? []).filter((r) => r.eventKey !== eventKey) });
  appendNote(id, "rule", `Deleted the trigger rule for "${eventKey}" — the static heuristic answers again.`);
  return rule;
}

export type TriggerRuleStatus = "ok" | "stale" | "error" | "disabled" | "orphaned";

/** The content hash embedded in a rule filename (…rule.<eventKey>.<hash12>.mjs). */
function fileHash(file: string): string {
  const stem = file.replace(/\.mjs$/i, "");
  return stem.slice(stem.lastIndexOf(".") + 1);
}

/** Health of one rule against the LIVE model — computed on read (the model hot-
 * reloads per request; there is no reload hook to invalidate against). Pass the
 * owning `cfg` so the runtime-disabling conditions the derive path enforces
 * (event re-rooted off this table, event became a coupled satellite) surface
 * here too — otherwise a read surface would show "ok" for a rule derive silently
 * ignores. */
export function ruleStatus(rule: TriggerRule, ont: Ontology, cfg?: AdapterConfig): { status: TriggerRuleStatus; detail?: string } {
  if (rule.disabled) return { status: "disabled", detail: rule.disabledReason };
  const event = ont.eventByKey(rule.eventKey);
  if (!event) return { status: "orphaned", detail: `event "${rule.eventKey}" is not in the loaded model` };
  if (cfg && event.aggregateRoot !== cfg.targetEntity) {
    return { status: "orphaned", detail: `event moved to aggregate "${event.aggregateRoot}" — this connector targets ${cfg.targetEntity}; recompile or re-point` };
  }
  if (event.coupledTo) {
    return { status: "orphaned", detail: `event now completes with "${event.coupledTo}" — a coupled satellite mirrors its predecessor and cannot carry a rule` };
  }
  const code = readRuleFile(rule.file);
  if (code === null) return { status: "error", detail: `rule file missing (${rule.file})` };
  if (fileHash(rule.file) !== sha256(code).slice(0, 12)) {
    return { status: "error", detail: "rule file tampered — content does not match its content-hash name" };
  }
  const scan = ruleScan(code);
  if (!scan.ok) return { status: "error", detail: `deny-scan: ${scan.violations.join(", ")}` };
  if (gwtHashOf(event) !== rule.gwtHash) {
    return { status: "stale", detail: "the event's acceptance criteria changed since this rule was compiled" };
  }
  return { status: "ok" };
}

// Compiled detect() functions cached by absolute path — safe because paths are
// content-addressed (a recompile is a NEW path; the old entry is a few hundred
// bytes of dead closure, the accepted authored-body cost). A same-path overwrite
// by a sandboxed connector child is caught by the content-hash check below, so
// serving a warm-cached (original, verified) fn is the safe side.
const fnCache = new Map<string, AuthoredRuleFn>();

async function loadRuleFn(file: string): Promise<AuthoredRuleFn> {
  const abs = ruleAbsPath(file);
  const cached = fnCache.get(abs);
  // A deleted file must not keep firing from the module cache — one existsSync
  // per rule per derive pass buys honest "file missing" errors.
  if (cached && existsSync(abs)) return cached;
  const code = readRuleFile(file);
  if (code === null) throw new Error(`rule file missing (${file})`);
  // Integrity: the filename encodes the content hash. A same-path overwrite
  // (the one write the sandboxed connector child can do to this workspace) no
  // longer matches — reject rather than execute host-process code the child
  // planted. This is the boundary the content-addressing was meant to provide.
  if (fileHash(file) !== sha256(code).slice(0, 12)) {
    throw new Error("rule file integrity check failed — content does not match its content-hash name");
  }
  // Load-time re-scan: defense in depth, exactly like the authored-body host —
  // a file edited on disk after the write-time gate does not slip through.
  const scan = ruleScan(code);
  if (!scan.ok) throw new Error(`rule failed the deny-scan (${scan.violations.join(", ")})`);
  const mod = (await import(pathToFileURL(abs).href)) as { detect?: unknown };
  if (typeof mod.detect !== "function") throw new Error("rule must export function detect(row, ctx, previous)");
  const fn = mod.detect as AuthoredRuleFn;
  fnCache.set(abs, fn);
  return fn;
}

const MAX_LOG_LINES = 200;

/**
 * Load every eligible trigger rule for the ACTIVE workflow into an
 * AuthoredRuleSet for one derive pass, with a full health report. Returns
 * `set: undefined` (and an explanatory report) when nothing is eligible:
 * no rules configured, off-context (boot/tests — connector resolution needs the
 * tenant scope), or the connector kill-switch is off (every rule surfaced as
 * disabled — visible, not silent).
 *
 * Table snapshots for ctx.readTable are assembled ONLY when at least one rule
 * loaded — rule-free workflows pay zero. Rows are SHALLOW-COPIED (and capped at
 * SNAPSHOT_ROWS_PER_TABLE) so a buggy rule mutating what it reads can never
 * corrupt the planner's own row set.
 */
export async function loadAuthoredRuleSet(
  ont: Ontology,
  rowsByEntity: Map<string, Array<Record<string, unknown>>>,
): Promise<{ set: AuthoredRuleSet | undefined; report: RuleReport }> {
  const report: RuleReport = { active: 0, stale: [], errors: [], disabled: [] };
  const { workflowId } = connectorOwner();
  const withRules = connectorsInWorkflow(workflowId).filter((c) => (c.triggerRules ?? []).length > 0);
  if (withRules.length === 0) return { set: undefined, report };

  if (!connectorsEnabled()) {
    for (const cfg of withRules) {
      for (const rule of cfg.triggerRules ?? []) {
        report.disabled.push({ eventKey: rule.eventKey, connector: cfg.id, reason: "connector subsystem disabled (kill-switch)" });
      }
    }
    return { set: undefined, report };
  }

  const rules = new Map<string, { detect: AuthoredRuleFn; condition?: string; connectorId?: string }>();
  for (const cfg of withRules) {
    for (const rule of cfg.triggerRules ?? []) {
      if (rule.disabled) {
        report.disabled.push({ eventKey: rule.eventKey, connector: cfg.id, reason: rule.disabledReason ?? "disabled by the operator" });
        continue;
      }
      const event = ont.eventByKey(rule.eventKey);
      if (!event) {
        report.disabled.push({ eventKey: rule.eventKey, connector: cfg.id, reason: "orphaned: event not in the loaded model" });
        continue;
      }
      if (event.aggregateRoot !== cfg.targetEntity) {
        report.disabled.push({
          eventKey: rule.eventKey, connector: cfg.id,
          reason: `event moved to aggregate ${event.aggregateRoot} — recompile against the current model`,
        });
        continue;
      }
      // Two more model-drift states planDerivation keys on that would otherwise
      // leave the rule loaded-but-never-consulted (silently inert): the event
      // became a coupled satellite (mirrors its predecessor — derive ignores the
      // authored entry), or it lost its command (derive skips the event). Report
      // both as disabled so no surface shows a dead rule as "active/ok".
      if (event.coupledTo) {
        report.disabled.push({
          eventKey: rule.eventKey, connector: cfg.id,
          reason: `event now completes with ${event.coupledTo} — a coupled satellite cannot carry a rule`,
        });
        continue;
      }
      if (!event.commandName) {
        report.disabled.push({
          eventKey: rule.eventKey, connector: cfg.id,
          reason: "event lost its command — not derivable from data",
        });
        continue;
      }
      if (gwtHashOf(event) !== rule.gwtHash) {
        // Stale still RUNS — drift is surfaced, never auto-applied.
        report.stale.push({ eventKey: rule.eventKey, connector: cfg.id });
      }
      try {
        const detect = await loadRuleFn(rule.file);
        rules.set(rule.eventKey, { detect, condition: rule.condition, connectorId: cfg.id });
      } catch (e: any) {
        report.errors.push({ eventKey: rule.eventKey, connector: cfg.id, error: String(e?.message ?? e).slice(0, 300) });
      }
    }
  }
  report.active = rules.size;
  if (rules.size === 0) return { set: undefined, report };

  // Snapshots: the planner's own aggregate-root tables (already in memory) plus
  // a capped top-up of every other populated entity/VO table.
  const snapshots = new Map<string, Array<Record<string, unknown>>>();
  for (const [name, rows] of rowsByEntity) {
    snapshots.set(name, rows.slice(0, SNAPSHOT_ROWS_PER_TABLE).map((r) => ({ ...r })));
  }
  for (const t of [...ont.entities, ...ont.valueObjects]) {
    if (snapshots.has(t.name)) continue;
    if (await store.tableExists(t.name)) {
      snapshots.set(t.name, (await store.findMany(t.name, SNAPSHOT_ROWS_PER_TABLE)).map((r) => ({ ...r })));
    }
  }
  const tables = [...snapshots.keys()];
  const readTable = (name: string): Array<Record<string, unknown>> => {
    if (snapshots.has(name)) return snapshots.get(name)!;
    const want = String(name ?? "").toLowerCase();
    for (const k of tables) if (k.toLowerCase() === want) return snapshots.get(k)!;
    return [];
  };

  // ctx.log lines accumulate on the SET (per-pass, per-load), not a module
  // global — deriveFromData reads them off DeriveResult, so concurrent passes
  // (across tenants) can never cross-contaminate each other's preview logs.
  const logs = new Map<string, string[]>();
  const now = new Date();
  const set: AuthoredRuleSet = {
    rules,
    logs,
    makeCtx(event: OntologyEvent, entity: EntitySchema): RuleContext {
      const lines = logs.get(event.key) ?? [];
      logs.set(event.key, lines);
      return {
        event: { key: event.key, ref: event.ref, name: event.name, acceptanceCriteria: event.acceptanceCriteria },
        entity,
        now,
        period: { of: periodOf, start: periodStart },
        tables,
        readTable,
        log(msg: string) {
          if (lines.length < MAX_LOG_LINES) lines.push(String(msg).slice(0, 500));
        },
      };
    },
  };
  return { set, report };
}

export interface RulePreview {
  eventKey: string;
  eventName: string;
  condition: string;
  status: TriggerRuleStatus;
  statusDetail?: string;
  /** Rows the rule fired for (new + already in the log). */
  fired: number;
  /** Of those, how many WOULD emit right now (not yet in the EventLog). */
  wouldEmitNow: number;
  alreadyInLog: number;
  noEvidence: number;
  samples: Array<{ id: string; evidence: string }>;
  ruleError?: string;
  log: string[];
}

/** Dry-run one rule against the live rows: a preview derive pass (nothing is
 * emitted), focused on the rule's event — the build flow's oracle. The oracle is
 * only honest if it reports when the rule did NOT run: a rule that failed to load
 * (syntax error, tamper, deny-scan) or was disabled (drift, kill-switch) shows
 * the STATIC heuristic's counts, so its status/ruleError must reflect that or the
 * build ritual would conclude a broken rule works. */
export async function previewRule(id: string, eventKeyOrName: string): Promise<RulePreview> {
  const cfg = readSidecar(id);
  if (!cfg) throw new NotFoundError(`no connector "${id}"`);
  const ont = getOntology();
  const event = resolveRuleEvent(ont, eventKeyOrName);
  if (!event) throw new DomainError(`no event "${eventKeyOrName}" in the loaded model`);
  const rule = (cfg.triggerRules ?? []).find((r) => r.eventKey === event.key);
  if (!rule) throw new NotFoundError(`connector "${id}" has no rule for event "${event.name}"`);
  const st = ruleStatus(rule, ont, cfg);
  const r = await deriveFromData({ preview: true });
  const ev = r.events.find((e) => e.key === event.key);
  // Did the rule actually run this pass? Fold the derive pass's own verdict in:
  // a load error (rules.errors) or a disable (rules.disabled) means the counts
  // above are the static fallback's, not this rule's — surface it as ruleError.
  const loadError = r.rules?.errors.find((e) => e.eventKey === event.key)?.error;
  const disabled = r.rules?.disabled.find((e) => e.eventKey === event.key)?.reason;
  const ranAuthored = ev?.kind === "authored";
  const ruleError =
    ev?.ruleError ??
    loadError ??
    (!ranAuthored && disabled ? `rule did not run (${disabled}); counts below are the static heuristic's` : undefined) ??
    (!ranAuthored ? "rule did not run; counts below are the static heuristic's" : undefined);
  return {
    eventKey: event.key,
    eventName: event.name,
    condition: rule.condition,
    status: st.status,
    ...(st.detail ? { statusDetail: st.detail } : {}),
    fired: (ev?.emitted ?? 0) + (ev?.alreadyPresent ?? 0),
    wouldEmitNow: ev?.emitted ?? 0,
    alreadyInLog: ev?.alreadyPresent ?? 0,
    noEvidence: ev?.noEvidence ?? 0,
    samples: ev?.samples ?? [],
    ...(ruleError ? { ruleError } : {}),
    log: r.ruleLogs?.[event.key] ?? [],
  };
}
