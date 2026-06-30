// Organisation-level portfolio dashboard — one tier ABOVE the per-workflow-type
// overview. It spans EVERY workflow type in an organisation at once (hardware
// production, base-station maintenance, customer implementation, …) and answers
// the questions an ops leader acts on: how much live work, is it flowing or
// piling up, where is time lost, what's the exception queue, how real is the twin.
//
// Two grounding rules make this work without disturbing the single-workflow data
// plane:
//   1. CROSS-WORKFLOW EVENTS come from ONE Prisma query over the append-only
//      EventLog filtered by organizationId (indexed). No per-workflow context
//      switch, no global-ontology swap.
//   2. PER-WORKFLOW STEP STRUCTURE (linear order, terminal step, role/BC per
//      step) is read by loading each workflow's model content LOCALLY via
//      loadOntologyFromStrings() — a fresh Ontology object, never the process
//      singleton getOntology() returns. So computing one workflow's shape can
//      never corrupt the model bound to the live request.
//
// CAPABILITY-GATING: some panels need an attribute the model doesn't label on its
// own (e.g. which payload field is the COMMITMENT/DUE date). Each such capability
// is mapped PER WORKFLOW (admin action, persisted in _app_meta). A panel renders
// ready / partial / locked from how many of the org's modelled workflows are
// mapped — so the board is useful immediately and lights up as you map.

import { prisma } from "../db.js";
import { currentContent } from "../platform/ontology-store/ontology-store.js";
import { loadOntologyFromStrings, type Ontology } from "../ontology/model.js";
import { getMeta, setMeta } from "./projection-store.js";

// ---------------------------------------------------------------------------
// Capability registry — the data inputs panels can require. Derived capabilities
// (auto-satisfied, e.g. the throughput/trust panels) are NOT listed here; only
// the ones a human must MAP appear, because those are what the mapping dialog and
// the gating notices are about.
// ---------------------------------------------------------------------------

export interface CapabilityDef {
  key: string;
  label: string;
  description: string;
  /** Panels that come alive once this capability is mapped (for UI copy). */
  unlocks: string;
}

export const CAPABILITIES: CapabilityDef[] = [
  {
    key: "commitDate",
    label: "Commitment / due date",
    description:
      "Which field on this workflow carries the promised delivery / due date. The model can't tell a due-date from a created-date on its own, so point us at the right one.",
    unlocks: "Timeliness — overdue work, on-time rate, and (next) predicted lateness.",
  },
];

// Per-workflow mapping: capability key → the model field name it resolves to.
export type WorkflowMapping = Record<string, string>;
// Org-wide: workflowId → its mapping.
export type OrgMappings = Record<string, WorkflowMapping>;

const mapKey = (orgId: string) => `orgdash:mappings:${orgId}`;

/** Every workflow mapping in the org (empty object when none configured). */
export async function getOrgMappings(orgId: string): Promise<OrgMappings> {
  const raw = await getMeta(mapKey(orgId));
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as OrgMappings) : {};
  } catch {
    return {};
  }
}

/** Set (or clear) one capability mapping for one workflow. Passing an empty/blank
 * field clears that capability. Returns the full updated org mapping set. */
export async function setWorkflowMapping(
  orgId: string,
  workflowId: string,
  capabilityKey: string,
  field: string | null,
): Promise<OrgMappings> {
  if (!CAPABILITIES.some((c) => c.key === capabilityKey)) {
    throw new Error(`unknown dashboard capability "${capabilityKey}"`);
  }
  const all = await getOrgMappings(orgId);
  const wf = { ...(all[workflowId] ?? {}) };
  if (field && field.trim()) wf[capabilityKey] = field.trim();
  else delete wf[capabilityKey];
  if (Object.keys(wf).length) all[workflowId] = wf;
  else delete all[workflowId];
  await setMeta(mapKey(orgId), JSON.stringify(all));
  return all;
}

// ---------------------------------------------------------------------------
// Ontology helpers (operate on a LOCALLY-loaded Ontology, never the singleton).
// ---------------------------------------------------------------------------

interface OrderInfo {
  refs: string[]; // event $refs in linear (demo) order
  total: number;
  terminal: string | null; // last step's $ref
  indexByRef: Map<string, number>;
}

function orderInfo(ont: Ontology): OrderInfo {
  const refs = ont
    .linearOrder()
    .map((k) => ont.eventByKey(k)?.ref)
    .filter((r): r is string => !!r);
  const indexByRef = new Map(refs.map((r, i) => [r, i]));
  return { refs, total: refs.length, terminal: refs[refs.length - 1] ?? null, indexByRef };
}

const DATEISH_RE = /(date|time|due|deadline|eta|occurr|deliver|promise|schedul|week|when)/i;

export interface FieldOption {
  name: string;
  dataType?: string;
  dateish: boolean;
  source: "entity" | "command";
}

/** The fields a workflow exposes, for the mapping dialog's dropdowns. Date-shaped
 * fields are flagged and sorted first; `suggested` is the best date guess. */
export function availableFields(ont: Ontology): { fields: FieldOption[]; suggested: string | null } {
  const seen = new Map<string, FieldOption>();
  const consider = (name: string, dataType: string | undefined, source: "entity" | "command") => {
    if (!name || name === "id" || seen.has(name)) return;
    const dateish = /date|time/i.test(dataType ?? "") || DATEISH_RE.test(name);
    seen.set(name, { name, dataType, dateish, source });
  };
  for (const e of ont.entities) for (const f of e.fields) consider(f.name, f.dataType, "entity");
  for (const c of ont.commands) for (const f of c.fields) consider(f.name, f.dataType, "command");
  const fields = [...seen.values()].sort((a, b) =>
    a.dateish === b.dateish ? a.name.localeCompare(b.name) : a.dateish ? -1 : 1,
  );
  // Suggested = the date-typed field with the most "occurrence/commitment" intent.
  const score = (f: FieldOption) => {
    let s = /date|time/i.test(f.dataType ?? "") ? 2 : DATEISH_RE.test(f.name) ? 1 : 0;
    if (/(due|deadline|eta|promise|deliver|commit)/i.test(f.name)) s += 2;
    return s;
  };
  const suggested = fields.filter((f) => f.dateish).sort((a, b) => score(b) - score(a))[0]?.name ?? null;
  return { fields, suggested };
}

// ---------------------------------------------------------------------------
// Date / week helpers
// ---------------------------------------------------------------------------

function asDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

/** ISO-week key "2026-W30" for bucketing throughput. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Portfolio computation
// ---------------------------------------------------------------------------

type EvtRow = {
  workflowId: string | null;
  caseId: string | null;
  eventRef: string;
  eventName: string;
  role: string;
  boundedContext: string;
  businessAt: Date | null;
  occurredAt: Date;
  provenance: string | null;
  aggregateId: string;
  actorKind: string | null;
};

interface InstanceState {
  caseId: string;
  firstAt: Date; // occurredAt of earliest event
  lastAt: Date; // occurredAt of latest event
  firstBiz: Date | null; // earliest businessAt (business "started")
  lastBiz: Date | null; // latest businessAt (business "as of")
  termBiz: Date | null; // businessAt of the terminal event, if reached
  bizByRef: Map<string, Date>; // last businessAt seen per step (for gap baselines)
  firedRefs: Set<string>;
  refCounts: Map<string, number>;
  realEvents: number;
  totalEvents: number;
  softFails: number;
  done: boolean;
  currentRef: string | null; // next unfired step's $ref (null if complete)
}

/** Derived expected-duration baseline for one workflow: the rolling P50 of the
 * businessAt gap per step, the implied total expected duration, and the 85th
 * percentile of completed end-to-end durations (the "aging vs own history" band).
 * All times in ms. Pure aggregation over data that already exists — this is the
 * keystone the research flagged: it unlocks cycle-time index, at-risk, and
 * commitment confidence simultaneously, with no new capture. */
interface WfBaseline {
  base: Map<string, number>; // eventRef → P50 ms to leave that step
  expectedTotal: number; // Σ base over all transitions
  p85: number | null; // 85th-percentile completed duration, or null (<1 completion)
}

const MS_DAY = 86_400_000;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** Build the derived baseline for one workflow from its instances' businessAt
 * gaps. Censored-aware: every observed transition contributes, whether or not the
 * instance has finished, so survivorship bias is bounded. */
function computeBaseline(order: OrderInfo, insts: InstanceState[]): WfBaseline {
  const gaps = new Map<string, number[]>();
  for (const st of insts) {
    for (let j = 0; j < order.refs.length - 1; j++) {
      const da = st.bizByRef.get(order.refs[j]);
      const db = st.bizByRef.get(order.refs[j + 1]);
      if (da && db) {
        const g = db.getTime() - da.getTime();
        if (g > 0) (gaps.get(order.refs[j]) ?? gaps.set(order.refs[j], []).get(order.refs[j])!).push(g);
      }
    }
  }
  const base = new Map<string, number>();
  let expectedTotal = 0;
  for (let j = 0; j < order.refs.length - 1; j++) {
    const v = median(gaps.get(order.refs[j]) ?? []);
    base.set(order.refs[j], v);
    expectedTotal += v;
  }
  const durs: number[] = [];
  for (const st of insts) {
    if (!st.done || !st.firstBiz) continue;
    const last = order.terminal ? st.bizByRef.get(order.terminal) : st.lastBiz;
    if (last && last.getTime() > st.firstBiz.getTime()) durs.push(last.getTime() - st.firstBiz.getTime());
  }
  return { base, expectedTotal, p85: durs.length ? percentile(durs, 85) : null };
}

export interface PortfolioResult {
  generatedAt: string;
  org: { id: string };
  workflows: WorkflowCard[];
  northStar: {
    activeInstances: number;
    totalInstances: number;
    completedInstances: number;
    throughputSeries: { week: string; count: number }[];
    completedRecent: number; // completions in the series window
    started: number;
    flowRatio: number | null; // completed ÷ started over the window; <1 = backlog grows
    twinTrust: { real: number; total: number; pct: number };
    conformance: { clean: number; total: number; pct: number };
    atRisk: number; // open instances running beyond their workflow's own history
    cycleIndex: number | null; // org median actual÷expected cycle time (1.0 = on baseline)
    workflowCount: number;
    modelledCount: number;
  };
  exceptions: ExceptionRow[];
  bottlenecks: Bottleneck[];
  capabilities: CapabilityStatus[];
  timeliness: TimelinessPanel | null;
  valueAtRisk: ValueAtRisk;
  connectorFreshness: ConnectorFreshness;
  aiActivity: AiActivity;
}

/** AI Activity & Trust (Workstream C) — now live, fed by the EventLog actorKind
 * stamp + the PDP audit log. `live=false` only when there has been zero attributed
 * activity yet (a fresh org), so the UI can show "no AI activity yet" instead of
 * implying instrumented zeros. */
export interface AiActivity {
  live: boolean;
  byKind: { human: number; ai: number; adapter: number; system: number };
  aiActionShare: { ai: number; human: number; pct: number | null }; // ai ÷ (ai+human) state-changing events
  override: { aiEvents: number; overridden: number; pct: number | null }; // ai events a human later corrected on the same aggregate
  guardrail: { aiAttempts: number; aiBlocked: number; pct: number | null }; // denied AI writes ÷ attempted (cumulative, from the audit log)
  note: string;
}

/** Days-first cost-of-delay: exposure measured in DAYS (the unit we actually
 * have), before any € rate table exists. overdue/slip need the commitDate
 * mapping; overrun needs only the derived baseline. */
export interface ValueAtRisk {
  overdueDays: number; // Σ days already past due across open commitments
  slipDays: number; // Σ projected days late for not-yet-overdue commitments
  overrunDays: number; // Σ business days at-risk instances run beyond their own 85th pct
  totalDays: number;
  hasCommitData: boolean; // a due date is mapped somewhere (else overdue/slip read 0)
  byWorkflow: { workflowId: string; workflowName: string; overdueDays: number; slipDays: number; overrunDays: number; totalDays: number }[];
}

/** Connector freshness / health. PREVIEW: currently STATIC sample data — there is
 * no real per-pull `lastPullAt` writer yet (AdapterConfig.lastPullAt is interface-
 * only). The shape is the contract a real wiring will fill: swap `sources` to read
 * now − lastPullAt per source + healthcheck, and flip `preview` to false. */
export interface ConnectorFreshness {
  preview: boolean;
  note: string;
  sources: { name: string; lastEventAgo: string; slaMinutes: number; status: "ok" | "stale" | "unknown" }[];
}

export interface WorkflowCard {
  id: string;
  name: string;
  workspaceId: string;
  hasModel: boolean;
  totalSteps: number;
  active: number;
  completed: number;
  total: number;
  throughputRecent: number;
  series: { week: string; count: number }[];
  reworkCount: number;
  softFailCount: number;
  twinTrust: { real: number; total: number; pct: number };
  oldestActive: { caseId: string; ageDays: number; stepName: string } | null;
  topRoleQueue: { role: string; count: number } | null;
  cycleIndex: number | null; // actual÷expected cycle time, P50 over completed (null until a baseline exists)
  expectedDays: number | null; // derived end-to-end expected duration, in days
  atRisk: number; // open instances past this workflow's 85th-percentile duration
  atRiskDays: number; // Σ business days those at-risk instances run beyond the 85th pct
}

export interface ExceptionRow {
  kind: "overdue" | "at_risk" | "rework" | "soft_fail" | "aging";
  severity: number;
  workflowId: string;
  workflowName: string;
  caseId: string;
  title: string;
  detail: string;
  ageDays: number;
}

export interface Bottleneck {
  workflowId: string;
  workflowName: string;
  eventRef: string;
  stepName: string;
  role: string;
  boundedContext: string;
  waiting: number;
}

export interface CapabilityStatus extends CapabilityDef {
  state: "ready" | "partial" | "locked";
  modelledCount: number;
  mappedCount: number;
  unmapped: { id: string; name: string }[];
}

export interface TimelinessPanel {
  scopeWorkflows: { id: string; name: string; field: string }[];
  overdue: number;
  predictedLate: number; // not yet overdue, but the baseline projects a miss
  onTime: number;
  scorable: number;
  unscorable: number;
  overdueDays: number; // Σ days past due over ALL overdue (not just displayed rows)
  slipDays: number; // Σ projected slip days over ALL predicted-late
  daysByWorkflow: { workflowId: string; overdueDays: number; slipDays: number }[];
  rows: {
    workflowId: string; workflowName: string; caseId: string; dueDate: string;
    kind: "overdue" | "predicted"; days: number; predictedFinish?: string;
  }[];
  partial: { unmapped: { id: string; name: string }[] } | null;
}

const SERIES_WEEKS = 8;

export async function computePortfolio(orgId: string): Promise<PortfolioResult> {
  const now = new Date();

  const workflows = await prisma.platWorkflow.findMany({
    where: { organizationId: orgId, lifecycleState: "active" },
    select: { id: true, name: true, workspaceId: true },
    orderBy: { createdAt: "asc" },
  });
  const onts = await prisma.platOntology.findMany({
    where: { organizationId: orgId, name: "workflow", workflowId: { not: null } },
    select: { id: true, workflowId: true },
  });
  const ontIdByWf = new Map(onts.map((o) => [o.workflowId as string, o.id]));

  // Load each workflow's model LOCALLY (no global swap). A workflow with no model
  // yet stays in the grid as a "needs model" card.
  const loaded = new Map<string, { ont: Ontology; order: OrderInfo }>();
  for (const wf of workflows) {
    const ontId = ontIdByWf.get(wf.id);
    if (!ontId) continue;
    const content = await currentContent(orgId, ontId);
    if (!content) continue;
    try {
      const ont = loadOntologyFromStrings(content.workflow, content.overlay);
      loaded.set(wf.id, { ont, order: orderInfo(ont) });
    } catch {
      /* a malformed stored model just reads as "no model" — never throws the board down */
    }
  }

  const events = (await prisma.eventLog.findMany({
    where: { organizationId: orgId },
    select: {
      workflowId: true, caseId: true, eventRef: true, eventName: true, role: true,
      boundedContext: true, businessAt: true, occurredAt: true, provenance: true, aggregateId: true,
      actorKind: true,
    },
    orderBy: { occurredAt: "asc" },
  })) as EvtRow[];

  // Group events → per-workflow → per-instance state.
  const byWf = new Map<string, Map<string, InstanceState>>();
  for (const e of events) {
    if (!e.workflowId || !e.caseId) continue;
    const order = loaded.get(e.workflowId)?.order;
    let insts = byWf.get(e.workflowId);
    if (!insts) byWf.set(e.workflowId, (insts = new Map()));
    let st = insts.get(e.caseId);
    if (!st) {
      st = {
        caseId: e.caseId, firstAt: e.occurredAt, lastAt: e.occurredAt, firstBiz: null, lastBiz: null,
        termBiz: null, bizByRef: new Map(), firedRefs: new Set(), refCounts: new Map(), realEvents: 0,
        totalEvents: 0, softFails: 0, done: false, currentRef: null,
      };
      insts.set(e.caseId, st);
    }
    if (e.occurredAt < st.firstAt) st.firstAt = e.occurredAt;
    if (e.occurredAt > st.lastAt) st.lastAt = e.occurredAt;
    if (e.businessAt) {
      st.bizByRef.set(e.eventRef, e.businessAt); // last write per step wins (matches latest state)
      if (!st.firstBiz || e.businessAt < st.firstBiz) st.firstBiz = e.businessAt;
      if (!st.lastBiz || e.businessAt > st.lastBiz) st.lastBiz = e.businessAt;
    }
    st.totalEvents++;
    if (e.provenance === "recorded" || e.provenance === "live") st.realEvents++;
    if (e.aggregateId === "") st.softFails++; // soft-fail marker: twin couldn't synthesize the step
    st.firedRefs.add(e.eventRef);
    st.refCounts.set(e.eventRef, (st.refCounts.get(e.eventRef) ?? 0) + 1);
    if (order && e.eventRef === order.terminal) st.termBiz = e.businessAt;
  }

  // Finalize per-instance derived fields using each workflow's order.
  for (const [wfId, insts] of byWf) {
    const order = loaded.get(wfId)?.order;
    for (const st of insts.values()) {
      if (order) {
        st.done = !!order.terminal && st.firedRefs.has(order.terminal);
        st.currentRef = st.done ? null : (order.refs.find((r) => !st.firedRefs.has(r)) ?? null);
      } else {
        // No model → treat any instance with events as "active, step unknown".
        st.done = false;
        st.currentRef = null;
      }
    }
  }

  // Derived per-workflow baseline (the keystone): P50 step gaps + expected total
  // + the 85th-percentile completed-duration band that "at-risk" measures against.
  const baselines = new Map<string, WfBaseline>();
  for (const wf of workflows) {
    const order = loaded.get(wf.id)?.order;
    if (order) baselines.set(wf.id, computeBaseline(order, [...(byWf.get(wf.id)?.values() ?? [])]));
  }

  const mappings = await getOrgMappings(orgId);

  // ---- Per-workflow cards + org rollups ----
  const cards: WorkflowCard[] = [];
  let orgActive = 0, orgTotal = 0, orgCompleted = 0, orgReal = 0, orgEvents = 0, orgClean = 0, orgStarted = 0, orgAtRisk = 0;
  const orgSeries = new Map<string, number>();
  const orgCycleIdxs: number[] = [];

  for (const wf of workflows) {
    const has = loaded.has(wf.id);
    const order = loaded.get(wf.id)?.order;
    const ont = loaded.get(wf.id)?.ont;
    const bl = baselines.get(wf.id);
    const insts = [...(byWf.get(wf.id)?.values() ?? [])];

    let active = 0, completed = 0, rework = 0, softFail = 0, real = 0, evTotal = 0, clean = 0, atRisk = 0, atRiskMs = 0;
    const series = new Map<string, number>();
    const roleQueue = new Map<string, number>();
    const cycleIdxs: number[] = [];
    let oldest: WorkflowCard["oldestActive"] = null;

    for (const st of insts) {
      evTotal += st.totalEvents;
      real += st.realEvents;
      clean += st.totalEvents - st.softFails;
      if (st.softFails) softFail++;
      if ([...st.refCounts.values()].some((n) => n > 1)) rework++;
      if (st.done) {
        completed++;
        if (st.termBiz) series.set(isoWeekKey(st.termBiz), (series.get(isoWeekKey(st.termBiz)) ?? 0) + 1);
        // cycle-time index: actual end-to-end ÷ derived expected.
        if (bl && bl.expectedTotal > 0 && st.firstBiz) {
          const last = order?.terminal ? st.bizByRef.get(order.terminal) : st.lastBiz;
          if (last && last.getTime() > st.firstBiz.getTime()) cycleIdxs.push((last.getTime() - st.firstBiz.getTime()) / bl.expectedTotal);
        }
      } else {
        active++;
        const ageDays = daysBetween(st.firstAt, now);
        const stepName = st.currentRef && ont ? ont.eventByRef(st.currentRef)?.name ?? "—" : "—";
        if (!oldest || ageDays > oldest.ageDays) oldest = { caseId: st.caseId, ageDays, stepName };
        if (st.currentRef && ont) {
          const role = ont.eventByRef(st.currentRef)?.role ?? "—";
          roleQueue.set(role, (roleQueue.get(role) ?? 0) + 1);
        }
        // at-risk: business time elapsed already exceeds this workflow's own 85th-percentile completion.
        if (bl && bl.p85 != null && st.firstBiz && st.lastBiz) {
          const over = st.lastBiz.getTime() - st.firstBiz.getTime() - bl.p85;
          if (over > 0) { atRisk++; atRiskMs += over; }
        }
      }
    }

    // started (root creations) within the series window, by businessAt of the
    // earliest event — used for the org flow ratio.
    const windowWeeks = recentWeeks(now, SERIES_WEEKS);
    let startedRecent = 0, throughputRecent = 0;
    for (const st of insts) {
      if (st.firstBiz && windowWeeks.has(isoWeekKey(st.firstBiz))) startedRecent++;
      if (st.done && st.termBiz && windowWeeks.has(isoWeekKey(st.termBiz))) throughputRecent++;
    }

    const topRole = [...roleQueue.entries()].sort((a, b) => b[1] - a[1])[0];
    const cycleIndex = cycleIdxs.length ? Math.round(median(cycleIdxs) * 100) / 100 : null;
    cards.push({
      id: wf.id, name: wf.name, workspaceId: wf.workspaceId, hasModel: has,
      totalSteps: order?.total ?? 0,
      active, completed, total: insts.length,
      throughputRecent,
      series: seriesRows(now, series),
      reworkCount: rework, softFailCount: softFail,
      twinTrust: { real, total: evTotal, pct: pct(real, evTotal) },
      oldestActive: oldest,
      topRoleQueue: topRole ? { role: topRole[0], count: topRole[1] } : null,
      cycleIndex,
      expectedDays: bl && bl.expectedTotal > 0 ? Math.round((bl.expectedTotal / MS_DAY) * 10) / 10 : null,
      atRisk,
      atRiskDays: Math.round(atRiskMs / MS_DAY),
    });

    orgActive += active; orgCompleted += completed; orgTotal += insts.length;
    orgReal += real; orgEvents += evTotal; orgClean += clean; orgStarted += startedRecent; orgAtRisk += atRisk;
    if (cycleIndex != null) orgCycleIdxs.push(cycleIndex);
    for (const [w, c] of series) orgSeries.set(w, (orgSeries.get(w) ?? 0) + c);
  }

  const orgSeriesRows = seriesRows(now, orgSeries);
  const completedRecent = orgSeriesRows.reduce((s, r) => s + r.count, 0);

  // ---- Exceptions (deduped, ranked by severity then age) ----
  const exceptions: ExceptionRow[] = [];
  const AGING_DAYS = 3;
  for (const wf of workflows) {
    const ont = loaded.get(wf.id)?.ont;
    const bl = baselines.get(wf.id);
    for (const st of byWf.get(wf.id)?.values() ?? []) {
      const ageDays = daysBetween(st.lastAt, now);
      if (st.done) continue;
      const overP85 = bl && bl.p85 != null && st.firstBiz && st.lastBiz && st.lastBiz.getTime() - st.firstBiz.getTime() > bl.p85;
      if (overP85) {
        const overBy = Math.round((st.lastBiz!.getTime() - st.firstBiz!.getTime() - bl!.p85!) / MS_DAY);
        const stepName = st.currentRef && ont ? ont.eventByRef(st.currentRef)?.name ?? "—" : "—";
        exceptions.push({ kind: "at_risk", severity: 4, workflowId: wf.id, workflowName: wf.name, caseId: st.caseId,
          title: "At risk", detail: `${overBy}d beyond the usual time, stuck at "${stepName}"`, ageDays });
      } else if ([...st.refCounts.values()].some((n) => n > 1)) {
        const loops = Math.max(...st.refCounts.values()) - 1;
        exceptions.push({ kind: "rework", severity: 3, workflowId: wf.id, workflowName: wf.name, caseId: st.caseId,
          title: "Rework loop", detail: `a step repeated ${loops}× — work kicked back`, ageDays });
      } else if (st.softFails) {
        exceptions.push({ kind: "soft_fail", severity: 2, workflowId: wf.id, workflowName: wf.name, caseId: st.caseId,
          title: "Twin couldn't advance", detail: `${st.softFails} step(s) failed to synthesize from the source model`, ageDays });
      } else if (ageDays >= AGING_DAYS) {
        const stepName = st.currentRef && ont ? ont.eventByRef(st.currentRef)?.name ?? "—" : "—";
        exceptions.push({ kind: "aging", severity: 1, workflowId: wf.id, workflowName: wf.name, caseId: st.caseId,
          title: "No activity", detail: `idle ${ageDays}d at "${stepName}"`, ageDays });
      }
    }
  }

  // ---- Bottlenecks (waiting count per current step, across the portfolio) ----
  const bnMap = new Map<string, Bottleneck>();
  for (const wf of workflows) {
    const ont = loaded.get(wf.id)?.ont;
    if (!ont) continue;
    for (const st of byWf.get(wf.id)?.values() ?? []) {
      if (st.done || !st.currentRef) continue;
      const ev = ont.eventByRef(st.currentRef);
      const key = `${wf.id}|${st.currentRef}`;
      const cur = bnMap.get(key) ?? {
        workflowId: wf.id, workflowName: wf.name, eventRef: st.currentRef,
        stepName: ev?.name ?? "—", role: ev?.role ?? "—", boundedContext: ev?.boundedContext ?? "—", waiting: 0,
      };
      cur.waiting++;
      bnMap.set(key, cur);
    }
  }

  // ---- Capability gating + the (gated) Timeliness panel ----
  const modelledWf = workflows.filter((w) => loaded.has(w.id));
  const capabilities: CapabilityStatus[] = CAPABILITIES.map((cap) => {
    const mapped = modelledWf.filter((w) => mappings[w.id]?.[cap.key]);
    const unmapped = modelledWf.filter((w) => !mappings[w.id]?.[cap.key]).map((w) => ({ id: w.id, name: w.name }));
    const state: CapabilityStatus["state"] = mapped.length === 0 ? "locked" : mapped.length < modelledWf.length ? "partial" : "ready";
    return { ...cap, state, modelledCount: modelledWf.length, mappedCount: mapped.length, unmapped };
  });

  const timeliness = await computeTimeliness(orgId, modelledWf, mappings, byWf, loaded, baselines, now);

  // ---- Days-first cost-of-delay (overdue + projected slip + at-risk over-run) ----
  const slipByWf = new Map((timeliness?.daysByWorkflow ?? []).map((d) => [d.workflowId, d]));
  const varByWf = cards
    .map((c) => {
      const td = slipByWf.get(c.id);
      const overdueDays = td?.overdueDays ?? 0, slipDays = td?.slipDays ?? 0, overrunDays = c.atRiskDays;
      return { workflowId: c.id, workflowName: c.name, overdueDays, slipDays, overrunDays, totalDays: overdueDays + slipDays + overrunDays };
    })
    .filter((v) => v.totalDays > 0)
    .sort((a, b) => b.totalDays - a.totalDays);
  const valueAtRisk: ValueAtRisk = {
    overdueDays: timeliness?.overdueDays ?? 0,
    slipDays: timeliness?.slipDays ?? 0,
    overrunDays: cards.reduce((s, c) => s + c.atRiskDays, 0),
    totalDays: (timeliness?.overdueDays ?? 0) + (timeliness?.slipDays ?? 0) + cards.reduce((s, c) => s + c.atRiskDays, 0),
    hasCommitData: timeliness != null,
    byWorkflow: varByWf,
  };

  // ---- Connector freshness (PREVIEW: static placeholder until real lastPullAt wiring) ----
  const connectorFreshness = buildConnectorFreshness(loaded);

  // ---- AI Activity & Trust (live, fed by actorKind + the PDP audit log) ----
  const aiActivity = await computeAiActivity(orgId, events);

  return {
    generatedAt: now.toISOString(),
    org: { id: orgId },
    workflows: cards,
    northStar: {
      activeInstances: orgActive,
      totalInstances: orgTotal,
      completedInstances: orgCompleted,
      throughputSeries: orgSeriesRows,
      completedRecent,
      started: orgStarted,
      flowRatio: orgStarted > 0 ? Math.round((completedRecent / orgStarted) * 100) / 100 : null,
      twinTrust: { real: orgReal, total: orgEvents, pct: pct(orgReal, orgEvents) },
      conformance: { clean: orgClean, total: orgEvents, pct: pct(orgClean, orgEvents) },
      atRisk: orgAtRisk,
      cycleIndex: orgCycleIdxs.length ? Math.round(median(orgCycleIdxs) * 100) / 100 : null,
      workflowCount: workflows.length,
      modelledCount: modelledWf.length,
    },
    exceptions: exceptions.sort((a, b) => b.severity - a.severity || b.ageDays - a.ageDays).slice(0, 14),
    bottlenecks: [...bnMap.values()].sort((a, b) => b.waiting - a.waiting).slice(0, 8),
    capabilities,
    timeliness,
    valueAtRisk,
    connectorFreshness,
    aiActivity,
  };
}

/** Autonomy mix + override + guardrail-block-rate over the org's events + audit
 * log. Honest heuristics, labelled as such: override is a same-aggregate
 * ai→human correction; guardrail is cumulative denied-AI-writes from the audit
 * log (not windowed). Legacy rows with no actorKind are bucketed as `system`. */
async function computeAiActivity(orgId: string, events: EvtRow[]): Promise<AiActivity> {
  const byKind = { human: 0, ai: 0, adapter: 0, system: 0 };
  for (const e of events) {
    const k = (e.actorKind ?? "system") as keyof typeof byKind;
    if (k in byKind) byKind[k]++;
    else byKind.system++;
  }

  // Override: an ai-origin event on an aggregate that a human later acts on (same
  // aggregateId, later in time). events is already ordered by occurredAt asc.
  const humanAfter = new Map<string, boolean>(); // aggregateId → a human event seen (scanning newest→oldest)
  let aiEvents = 0, overridden = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e.aggregateId) continue;
    if (e.actorKind === "human") humanAfter.set(e.aggregateId, true);
    else if (e.actorKind === "ai") {
      aiEvents++;
      if (humanAfter.get(e.aggregateId)) overridden++;
    }
  }

  // Guardrail: denied AI writes ÷ attempted, from the PDP audit log (cumulative).
  const aiAudits = await prisma.platAuditEvent.findMany({
    where: { organizationId: orgId, actorKind: "ai" },
    select: { decision: true },
  });
  const aiAttempts = aiAudits.length;
  const aiBlocked = aiAudits.filter((a) => a.decision === "deny").length;

  const actorTotal = byKind.ai + byKind.human;
  return {
    live: byKind.ai > 0 || byKind.human > 0 || aiAttempts > 0,
    byKind,
    aiActionShare: { ai: byKind.ai, human: byKind.human, pct: actorTotal ? pct(byKind.ai, actorTotal) : null },
    override: { aiEvents, overridden, pct: aiEvents ? pct(overridden, aiEvents) : null },
    guardrail: { aiAttempts, aiBlocked, pct: aiAttempts ? pct(aiBlocked, aiAttempts) : null },
    note: aiAttempts === 0 && byKind.ai === 0
      ? "No AI-originated activity yet — the assistant has not written to this org's workflows."
      : "Override is a same-aggregate ai→human correction heuristic; guardrail-block-rate is cumulative from the audit log.",
  };
}

// PREVIEW connector-freshness data. The source NAMES are real (the org's bounded
// contexts, from the loaded models), but the freshness / SLA / status values are
// STATIC samples — there is no per-pull lastPullAt writer yet. When the adapter
// layer starts stamping lastPullAt + healthchecks, replace the sample assignment
// with `now − lastPullAt` per source and set preview=false. Kept deliberately so
// the panel (and this gap) is never forgotten.
const FRESHNESS_SAMPLES: { lastEventAgo: string; slaMinutes: number; status: "ok" | "stale" | "unknown" }[] = [
  { lastEventAgo: "2m", slaMinutes: 15, status: "ok" },
  { lastEventAgo: "9m", slaMinutes: 15, status: "ok" },
  { lastEventAgo: "47m", slaMinutes: 60, status: "ok" },
  { lastEventAgo: "3h", slaMinutes: 120, status: "stale" },
  { lastEventAgo: "26m", slaMinutes: 30, status: "ok" },
  { lastEventAgo: "—", slaMinutes: 60, status: "unknown" },
];

function buildConnectorFreshness(loaded: Map<string, { ont: Ontology; order: OrderInfo }>): ConnectorFreshness {
  const names = new Set<string>();
  for (const { ont } of loaded.values()) for (const bc of ont.boundedContexts) names.add(bc);
  const list = names.size ? [...names].sort() : ["SAP", "Helix", "PRIM", "MES", "Test", "Logistics"];
  return {
    preview: true,
    note: "Preview — sample values. Connector freshness/health will read each adapter's real lastPullAt + healthcheck once the ingest layer is wired.",
    sources: list.map((name, i) => ({ name, ...FRESHNESS_SAMPLES[i % FRESHNESS_SAMPLES.length] })),
  };
}

/** Timeliness needs the per-instance commitment date, which lives in event
 * payloads — fetched here ONLY for mapped workflows, so the cost is paid only
 * once a due-date is actually configured. */
async function computeTimeliness(
  orgId: string,
  modelledWf: { id: string; name: string }[],
  mappings: OrgMappings,
  byWf: Map<string, Map<string, InstanceState>>,
  loaded: Map<string, { ont: Ontology; order: OrderInfo }>,
  baselines: Map<string, WfBaseline>,
  now: Date,
): Promise<TimelinessPanel | null> {
  const scope = modelledWf
    .map((w) => ({ id: w.id, name: w.name, field: mappings[w.id]?.commitDate }))
    .filter((w): w is { id: string; name: string; field: string } => !!w.field);
  if (scope.length === 0) return null;

  const scopeIds = scope.map((s) => s.id);
  const payloadRows = (await prisma.eventLog.findMany({
    where: { organizationId: orgId, workflowId: { in: scopeIds } },
    select: { workflowId: true, caseId: true, payload: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  })) as { workflowId: string | null; caseId: string | null; payload: string; occurredAt: Date }[];

  // Latest mapped-field value per instance (asc order ⇒ last write wins).
  const dueByInstance = new Map<string, Date>();
  for (const r of payloadRows) {
    if (!r.workflowId || !r.caseId) continue;
    const field = scope.find((s) => s.id === r.workflowId)?.field;
    if (!field) continue;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(r.payload) as Record<string, unknown>; } catch { continue; }
    const d = asDate(payload[field]);
    if (d) dueByInstance.set(`${r.workflowId}|${r.caseId}`, d);
  }

  let overdue = 0, predictedLate = 0, onTime = 0, scorable = 0, unscorable = 0, overdueDays = 0, slipDays = 0;
  const rows: TimelinessPanel["rows"] = [];
  const dayAcc = new Map<string, { overdueDays: number; slipDays: number }>();
  const bump = (wfId: string, k: "overdueDays" | "slipDays", d: number) => {
    const cur = dayAcc.get(wfId) ?? { overdueDays: 0, slipDays: 0 };
    cur[k] += d; dayAcc.set(wfId, cur);
  };
  const nameById = new Map(scope.map((s) => [s.id, s.name]));
  for (const s of scope) {
    const order = loaded.get(s.id)?.order;
    const bl = baselines.get(s.id);
    for (const st of byWf.get(s.id)?.values() ?? []) {
      if (st.done) continue; // open commitments only
      const due = dueByInstance.get(`${s.id}|${st.caseId}`);
      if (!due) { unscorable++; continue; }
      scorable++;
      const base = { workflowId: s.id, workflowName: nameById.get(s.id) ?? s.id, caseId: st.caseId, dueDate: due.toISOString().slice(0, 10) };
      if (due.getTime() < now.getTime()) {
        const d = daysBetween(due, now);
        overdue++; overdueDays += d; bump(s.id, "overdueDays", d);
        rows.push({ ...base, kind: "overdue", days: d });
        continue;
      }
      // Not yet overdue — project a finish from where it is now + the remaining
      // expected step durations (the derived baseline). A projection past the due
      // date is a predicted miss the leader can still act on.
      const predicted = projectFinish(st, order, bl);
      if (predicted && predicted.getTime() > due.getTime()) {
        const d = daysBetween(due, predicted);
        predictedLate++; slipDays += d; bump(s.id, "slipDays", d);
        rows.push({ ...base, kind: "predicted", days: d, predictedFinish: predicted.toISOString().slice(0, 10) });
      } else onTime++;
    }
  }

  const unmapped = modelledWf.filter((w) => !mappings[w.id]?.commitDate).map((w) => ({ id: w.id, name: w.name }));
  return {
    scopeWorkflows: scope,
    overdue, predictedLate, onTime, scorable, unscorable,
    overdueDays, slipDays,
    daysByWorkflow: [...dayAcc.entries()].map(([workflowId, v]) => ({ workflowId, ...v })),
    // Overdue first, then biggest projected slip.
    rows: rows.sort((a, b) => (a.kind === b.kind ? b.days - a.days : a.kind === "overdue" ? -1 : 1)).slice(0, 12),
    partial: unmapped.length ? { unmapped } : null,
  };
}

/** Project an open instance's finish: its latest business time + the sum of the
 * derived baseline durations for the steps it still has to traverse. Null when
 * there's no baseline or business anchor yet (so we never invent a prediction). */
function projectFinish(st: InstanceState, order: OrderInfo | undefined, bl: WfBaseline | undefined): Date | null {
  if (!order || !bl || !st.lastBiz) return null;
  const curIdx = st.currentRef ? order.indexByRef.get(st.currentRef) ?? order.refs.length : order.refs.length;
  let remaining = 0;
  for (let j = Math.max(0, curIdx - 1); j < order.refs.length - 1; j++) remaining += bl.base.get(order.refs[j]) ?? 0;
  return new Date(st.lastBiz.getTime() + remaining);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

function recentWeeks(now: Date, n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() - i * 7 * 86_400_000);
    out.add(isoWeekKey(d));
  }
  return out;
}

/** A dense series of the last SERIES_WEEKS weeks (oldest→newest), zero-filled. */
function seriesRows(now: Date, counts: Map<string, number>): { week: string; count: number }[] {
  const rows: { week: string; count: number }[] = [];
  for (let i = SERIES_WEEKS - 1; i >= 0; i--) {
    const wk = isoWeekKey(new Date(now.getTime() - i * 7 * 86_400_000));
    rows.push({ week: wk, count: counts.get(wk) ?? 0 });
  }
  return rows;
}

/** The mapping dialog's per-workflow field options + current mapping. */
export async function mappingConfig(orgId: string): Promise<{
  capabilities: CapabilityDef[];
  workflows: { id: string; name: string; hasModel: boolean; fields: FieldOption[]; suggested: string | null; mapping: WorkflowMapping }[];
}> {
  const workflows = await prisma.platWorkflow.findMany({
    where: { organizationId: orgId, lifecycleState: "active" },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  const onts = await prisma.platOntology.findMany({
    where: { organizationId: orgId, name: "workflow", workflowId: { not: null } },
    select: { id: true, workflowId: true },
  });
  const ontIdByWf = new Map(onts.map((o) => [o.workflowId as string, o.id]));
  const mappings = await getOrgMappings(orgId);

  const out = [];
  for (const wf of workflows) {
    const ontId = ontIdByWf.get(wf.id);
    let fields: FieldOption[] = [];
    let suggested: string | null = null;
    let hasModel = false;
    if (ontId) {
      const content = await currentContent(orgId, ontId);
      if (content) {
        try {
          const ont = loadOntologyFromStrings(content.workflow, content.overlay);
          ({ fields, suggested } = availableFields(ont));
          hasModel = true;
        } catch { /* no model */ }
      }
    }
    out.push({ id: wf.id, name: wf.name, hasModel, fields, suggested, mapping: mappings[wf.id] ?? {} });
  }
  return { capabilities: CAPABILITIES, workflows: out };
}
