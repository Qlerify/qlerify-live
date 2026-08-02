// Shared query engine + toolbar for the three Overview tabs (#flow, #rows,
// #list): free-text search, structured filters, multi-level sort, pagination
// and a column chooser — all combinable, all client-side over the full case
// set (the loaders fetch ?limit=0), and carried in the URL hash so any slice
// is shareable and survives the 5s live-poll re-renders. The search/sort/
// filter state is SHARED across the tabs (filter in the List, hop to the
// Workflow tab, and the merged counters show just that slice); page/pageSize
// (+ chosen columns for the List) are per-tab, with prefs in localStorage.
import { state } from "./state.js";
import { escapeHtml, prettyEntity } from "./format.js";
import { attrText, attrSearchText } from "./dashboard.js";
import { AUTH, render } from "./app.js";

// Per-tab page-size ladders: the List is a light table (250/page is fine), but
// each By-case row is a full SVG flow grid (hundreds of nodes), so it caps low.
export const PAGE_SIZES = { list: [10, 25, 50, 100, 250], rows: [10, 25, 50] };
const DEFAULT_PAGE_SIZE = { list: 25, rows: 10 };
function pageSizesFor(tab) { return PAGE_SIZES[tab] || PAGE_SIZES.list; }
// Default sort when the user hasn't chosen one: the List keeps the server's
// stable createdAt order; By-case keeps its "most recently active first".
const DEFAULT_SORT = { list: [], rows: [{ key: "lastAt", dir: -1 }], flow: [] };

// Same reserved set genericColumns/the server use, plus platform columns that
// must never surface as user-facing attributes.
const RESERVED = new Set(["id", "version", "createdAt", "updatedAt", "status", "progress", "total", "lastEvent", "dwellSeconds", "organization_id"]);

// ---------------------------------------------------------------------------
// Query state — lazy-init on the shared state object (expState pattern)
// ---------------------------------------------------------------------------

function prefKey(k) { return `ql.ov.${AUTH.workflow() || "-"}.${k}`; }
function pref(k, fallback) {
  try { const v = localStorage.getItem(prefKey(k)); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function setPref(k, v) {
  try { if (v == null) localStorage.removeItem(prefKey(k)); else localStorage.setItem(prefKey(k), JSON.stringify(v)); } catch { /* private mode etc. */ }
}

export function ovState() {
  // A workflow switch is SPA-style (no reload) and columns/prefs are model-
  // specific — drop the query state when the scope changes so one workflow's
  // filters/columns never bleed into another's (same pattern as chatScope).
  const wf = AUTH.workflow() || "-";
  if (state.ov && state.ov.wf !== wf) state.ov = null;
  if (!state.ov) {
    state.ov = {
      wf,
      q: "",
      // Structured filters: [{ field, op, value }] — field is a key in the
      // field registry ("progress", "createdAt", …, or "a:<attribute>").
      filters: [],
      // Multi-level sort in priority order: [{ key, dir: 1|-1 }].
      sort: [],
      // Quick progress-category chip: "" | "none" | "active" | "done".
      prog: "",
      // Quick relative-recency filter: which business date (Started vs last
      // Active) and how far back. within "" = off. See ACTIVITY_WINDOWS.
      activity: { field: "lastAt", within: "" },
      tab: {
        list: { page: 0, pageSize: normPageSize(pref("list.pageSize", DEFAULT_PAGE_SIZE.list), "list") },
        rows: { page: 0, pageSize: normPageSize(pref("rows.pageSize", DEFAULT_PAGE_SIZE.rows), "rows") },
      },
      // Chosen List columns (tokens: attribute names, or "$status"/"$createdAt"/
      // "$updatedAt"/"$lastEvent"). null = model default. Persisted per workflow.
      cols: pref("cols", null),
      // Which toolbar dropdowns are open (details survive re-renders via this).
      ui: { filters: false, sort: false, cols: false, activity: false },
    };
  }
  return state.ov;
}

function normPageSize(n, tab) {
  const l = pageSizesFor(tab);
  return l.includes(n) ? n : (DEFAULT_PAGE_SIZE[tab] ?? 25);
}

// Rolling recency windows for the Activity quick-filter, coarse→fine order kept
// for the menu. Days use calendar-day math, months/years shift the calendar
// field so "last 3 months" tracks the month boundary, not a flat 90 days.
const ACTIVITY_WINDOWS = [
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["3mo", "Last 3 months"],
  ["12mo", "Last 12 months"],
];
const ACTIVITY_FIELD = { startedAt: "Started", lastAt: "Active" };
function windowCutoff(within, nowMs) {
  if (!within) return null;
  const d = new Date(nowMs);
  switch (within) {
    case "24h": d.setDate(d.getDate() - 1); break;
    case "7d": d.setDate(d.getDate() - 7); break;
    case "30d": d.setDate(d.getDate() - 30); break;
    case "3mo": d.setMonth(d.getMonth() - 3); break;
    case "12mo": d.setFullYear(d.getFullYear() - 1); break;
    default: return null;
  }
  return d.getTime();
}
function activityLabel(a) {
  const w = ACTIVITY_WINDOWS.find(([v]) => v === a.within);
  return w ? `${ACTIVITY_FIELD[a.field] || "Active"} · ${w[1].toLowerCase()}` : "";
}

// The active-tab key for the current view ("dashboard" renders the List).
export function ovTabForView(view) {
  return view === "dashboard" ? "list" : view === "flow" || view === "rows" ? view : null;
}

// True when the query narrows the case set (sort alone doesn't).
export function ovActive() {
  const ov = ovState();
  return !!(ov.q.trim() || ov.prog || ov.activity?.within || ov.filters.some((f) => String(f.value ?? "") !== ""));
}

// ---------------------------------------------------------------------------
// Unified case records — /sim/cases rows joined with /sim/flow-by-case rows
// ---------------------------------------------------------------------------

// One record per case: `row` is the root-aggregate row (attributes + progress/
// total/status/lastEvent/createdAt/updatedAt), `fr` the flow row (counts +
// business startAt/lastAt + firings). Either side may be missing (a case with
// no events yet has no fr; an ingested log may reference a purged row).
export function caseRecords() {
  const out = [];
  const byId = new Map();
  for (const row of state.cases || []) {
    const rec = { id: String(row.id), row, fr: null };
    out.push(rec); byId.set(rec.id, rec);
  }
  for (const fr of state.flowRows?.cases || []) {
    const id = String(fr.caseId);
    const rec = byId.get(id);
    if (rec) rec.fr = fr; else out.push({ id, row: null, fr });
  }
  return out;
}

function stepsDone(r) {
  if (r.row && typeof r.row.progress === "number") return r.row.progress;
  return r.fr ? Object.keys(r.fr.counts || {}).length : 0;
}
function stepsTotal(r) {
  if (r.row && typeof r.row.total === "number" && r.row.total > 0) return r.row.total;
  return (state.events || []).length || 0;
}
export function pctOf(r) {
  const t = stepsTotal(r);
  return t > 0 ? Math.min(100, Math.round((stepsDone(r) / t) * 100)) : 0;
}
export function progressCat(r) {
  const done = stepsDone(r);
  if (done === 0) return "none";
  return done >= stepsTotal(r) ? "done" : "active";
}
const PROG_LABEL = { none: "Not started", active: "In progress", done: "Done" };

// ---------------------------------------------------------------------------
// Field registry — system fields + model attributes (sniffed types)
// ---------------------------------------------------------------------------

const SYS_FIELDS = {
  progress:  { label: "Progress %", type: "number", get: (r) => pctOf(r) },
  steps:     { label: "Steps done", type: "number", get: (r) => stepsDone(r) },
  total:     { label: "Steps total", type: "number", get: (r) => stepsTotal(r) },
  firings:   { label: "Event firings", type: "number", get: (r) => r.fr ? r.fr.firings : null },
  status:    { label: "Status", type: "string", get: (r) => r.row?.status ?? "" },
  id:        { label: "ID", type: "string", get: (r) => r.id },
  lastEvent: { label: "Last event name", type: "string", get: (r) => r.row?.lastEvent?.eventName ?? "" },
  createdAt: { label: "Created", type: "date", get: (r) => r.row?.createdAt ?? null },
  updatedAt: { label: "Updated", type: "date", get: (r) => r.row?.updatedAt ?? null },
  startedAt: { label: "Started (business)", type: "date", get: (r) => r.fr?.startAt || null },
  lastAt:    { label: "Last activity", type: "date", get: (r) => r.fr?.lastAt || r.row?.lastEvent?.occurredAt || null },
};

// Attribute columns: union of row keys across (up to) the first 100 records,
// minus reserved/platform keys — the candidate set for columns and filters.
export function attrColumns(records) {
  const keys = [];
  const seen = new Set();
  let n = 0;
  for (const r of records) {
    if (!r.row) continue;
    for (const k of Object.keys(r.row)) {
      if (seen.has(k) || RESERVED.has(k) || k.startsWith("_")) continue;
      seen.add(k); keys.push(k);
    }
    if (++n >= 100) break;
  }
  return keys;
}

// Sniff an attribute's type from its first non-empty values so filters get the
// right input widget and sorts compare numerically when they can.
function sniffType(records, key) {
  let seen = 0, num = 0, date = 0;
  for (const r of records) {
    if (!r.row) continue;
    const raw = r.row[key];
    if (raw == null || raw === "") continue;
    const s = attrText(raw);
    if (s === "—" || s === "") continue;
    seen++;
    if (s !== "" && !isNaN(Number(s))) num++;
    else if (/^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(Date.parse(s))) date++;
    if (seen >= 25) break;
  }
  if (seen && num === seen) return "number";
  if (seen && date === seen) return "date";
  return "string";
}

// Registry rebuilt once per render pass (applyQuery/ovToolbar both ensure it).
let _fields = null;
let _attrKeys = [];
export function ensureFields(records) {
  const attrs = attrColumns(records);
  _attrKeys = attrs;
  _fields = { ...SYS_FIELDS };
  for (const k of attrs) {
    _fields["a:" + k] = {
      label: prettyEntity(k),
      type: sniffType(records, k),
      attr: k,
      get: (r) => (r.row ? r.row[k] : null),
    };
  }
  return _fields;
}
export function fieldDef(key) { return (_fields || SYS_FIELDS)[key] || null; }

// ---------------------------------------------------------------------------
// The engine — filter → sort → page (pure over the unified records)
// ---------------------------------------------------------------------------

const HAYSTACK = new Map(); // id → { fp, text } — memoized search text per case
function haystack(r) {
  const fp = `${r.row?.updatedAt ?? ""}|${r.row?.progress ?? ""}|${r.fr?.lastAt ?? ""}|${r.fr?.firings ?? ""}`;
  const hit = HAYSTACK.get(r.id);
  if (hit && hit.fp === fp) return hit.text;
  const parts = [r.id];
  if (r.row) {
    for (const k of Object.keys(r.row)) {
      if (RESERVED.has(k) || k.startsWith("_")) continue;
      // Deep-flatten so nested object/array leaves are searchable too.
      const s = attrSearchText(r.row[k]);
      if (s) parts.push(s);
    }
    if (r.row.status) parts.push(String(r.row.status));
    if (r.row.lastEvent?.eventName) parts.push(r.row.lastEvent.eventName);
  }
  const text = parts.join("   ").toLowerCase();
  if (HAYSTACK.size > 5000) HAYSTACK.clear();
  HAYSTACK.set(r.id, { fp, text });
  return text;
}

function numOf(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(typeof raw === "number" ? raw : attrText(raw));
  return isFinite(n) ? n : null;
}

function matchFilter(r, f) {
  if (String(f.value ?? "") === "") return true; // incomplete row = no-op
  const def = fieldDef(f.field);
  if (!def) return true;
  const raw = def.get(r);
  if (def.type === "number") {
    const want = Number(f.value);
    if (!isFinite(want)) return true;
    const v = numOf(raw);
    if (v == null) return f.op === "neq";
    switch (f.op) {
      case "eq": return v === want;
      case "neq": return v !== want;
      case "gte": return v >= want;
      case "lte": return v <= want;
      case "gt": return v > want;
      case "lt": return v < want;
    }
    return true;
  }
  if (def.type === "date") {
    // f.value is a calendar day (yyyy-mm-dd) from <input type=date>; parse it as
    // LOCAL midnight. Row values that are themselves date-only (no time/zone)
    // must parse on the SAME local basis, or `Date.parse("2020-01-21")` (UTC
    // midnight) lands a day early in negative-offset zones. Full ISO timestamps
    // carry their own zone and are left untouched.
    const start = Date.parse(f.value + "T00:00:00");
    if (!isFinite(start)) return true;
    const end = start + 86400000;
    const sv = raw == null ? "" : String(attrTextIfNeeded(def, raw));
    const ts = sv ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(sv) ? sv + "T00:00:00" : sv) : NaN;
    if (!isFinite(ts)) return false;
    switch (f.op) {
      case "onafter": return ts >= start;
      case "onbefore": return ts < end;
      case "on": return ts >= start && ts < end;
    }
    return true;
  }
  const want = String(f.value).toLowerCase();
  // "contains" searches deep (nested leaves too); eq/neq/begins compare against
  // the human-readable collapsed scalar the cell actually shows.
  if (f.op === "contains") return (raw == null ? "" : attrSearchText(raw)).toLowerCase().includes(want);
  const s = (raw == null ? "" : attrText(raw)).toLowerCase();
  switch (f.op) {
    case "eq": return s === want;
    case "neq": return s !== want;
    case "begins": return s.startsWith(want);
  }
  return true;
}
// System date fields hold ISO strings; attribute dates may be wrapped values.
function attrTextIfNeeded(def, raw) { return def.attr ? attrText(raw) : raw; }

function sortVal(def, r) {
  const raw = def.get(r);
  if (raw == null || raw === "") return null;
  if (def.type === "number") return numOf(raw);
  if (def.type === "date") {
    const t = Date.parse(attrTextIfNeeded(def, raw));
    return isFinite(t) ? t : null;
  }
  const s = attrText(raw);
  return s === "—" ? null : s.toLowerCase();
}

function stableSort(records, sorts) {
  const levels = sorts.map((s) => ({ def: fieldDef(s.key), dir: s.dir === -1 ? -1 : 1 })).filter((l) => l.def);
  if (!levels.length) return records;
  const keyed = records.map((r, i) => ({ r, i, v: levels.map((l) => sortVal(l.def, r)) }));
  keyed.sort((A, B) => {
    for (let li = 0; li < levels.length; li++) {
      const a = A.v[li], b = B.v[li];
      const an = a == null, bn = b == null;
      if (an || bn) { if (an && bn) continue; return an ? 1 : -1; } // nulls last either way
      if (a < b) return -levels[li].dir;
      if (a > b) return levels[li].dir;
    }
    return A.i - B.i;
  });
  return keyed.map((k) => k.r);
}

// Filter → sort → page. `tab` ∈ "list" | "rows" | "flow" (flow: no paging).
// Returns { rows, total, page, pages, from, to } where total counts matches
// BEFORE paging. Snaps the page back into range when a filter shrinks results.
export function applyQuery(records, tab) {
  const ov = ovState();
  ensureFields(records);
  let out = records;
  if (ov.prog) out = out.filter((r) => progressCat(r) === ov.prog);
  const needle = ov.q.trim().toLowerCase();
  if (needle) out = out.filter((r) => haystack(r).includes(needle));
  for (const f of ov.filters) out = out.filter((r) => matchFilter(r, f));
  // Activity recency window (Started/Active within the last N): keep cases whose
  // chosen business date is at or after the rolling cutoff.
  if (ov.activity?.within) {
    const cutoff = windowCutoff(ov.activity.within, Date.now());
    const def = SYS_FIELDS[ov.activity.field] || SYS_FIELDS.lastAt;
    if (cutoff != null) {
      out = out.filter((r) => {
        const raw = def.get(r);
        const ts = raw ? Date.parse(raw) : NaN;
        return isFinite(ts) && ts >= cutoff;
      });
    }
  }
  const total = out.length;
  const sorts = ov.sort.length ? ov.sort : DEFAULT_SORT[tab] || [];
  out = stableSort(out, sorts);
  const t = ov.tab[tab];
  if (!t) return { rows: out, total, page: 0, pages: 1, from: total ? 1 : 0, to: total };
  const pages = Math.max(1, Math.ceil(total / t.pageSize));
  if (t.page >= pages) t.page = pages - 1;
  if (t.page < 0) t.page = 0;
  const from = t.page * t.pageSize;
  return { rows: out.slice(from, from + t.pageSize), total, page: t.page, pages, from: total ? from + 1 : 0, to: Math.min(total, from + t.pageSize) };
}

// Merged counts for the Workflow tab honouring the active query: sum the
// per-case count maps of just the matching cases. null = no query active (the
// caller falls back to the server-side aggregate) or per-case data not loaded.
export function flowSlice() {
  if (!ovActive() || !state.flowRows) return null;
  // Query over EVERY case so the match count and the "of N" denominator share
  // one universe (a case matching the search but with no events yet still counts
  // as a match; it simply contributes nothing to the merged counters).
  const recs = caseRecords();
  const res = applyQuery(recs, "flow");
  const counts = {};
  let totalFirings = 0;
  for (const r of res.rows) {
    if (!r.fr) continue;
    const c = r.fr.counts || {};
    for (const ref in c) { counts[ref] = (counts[ref] || 0) + c[ref]; totalFirings += c[ref]; }
  }
  return { counts, totalFirings, totalCases: res.total, allCases: recs.length };
}

// ---------------------------------------------------------------------------
// URL hash sync — #list?q=…&f=…&s=…&p=…&pg=…&n=…  (replaceState: no reload)
// ---------------------------------------------------------------------------

const esc = (s) => encodeURIComponent(String(s)).replace(/~/g, "%7E");
const unesc = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// Shared parts always; page/pageSize only when a tab is given (they are
// per-tab and deliberately dropped when hopping tabs via the view switcher).
export function serializeOv(tab) {
  const ov = ovState();
  const p = new URLSearchParams();
  if (ov.q.trim()) p.set("q", ov.q.trim());
  if (ov.prog) p.set("p", ov.prog);
  if (ov.activity?.within) p.set("act", `${ov.activity.field}:${ov.activity.within}`);
  for (const f of ov.filters) {
    if (String(f.value ?? "") === "") continue;
    p.append("f", `${esc(f.field)}~${f.op}~${esc(f.value)}`);
  }
  if (ov.sort.length) p.set("s", ov.sort.map((s) => (s.dir === -1 ? "-" : "") + esc(s.key)).join(","));
  const t = tab ? ov.tab[tab] : null;
  if (t) {
    if (t.page > 0) p.set("pg", String(t.page));
    if (t.pageSize !== DEFAULT_PAGE_SIZE[tab]) p.set("n", String(t.pageSize));
  }
  return p.toString();
}

export function hydrateOv(tab, qs) {
  const ov = ovState();
  const p = new URLSearchParams(qs || "");
  ov.q = p.get("q") || "";
  ov.prog = ["none", "active", "done"].includes(p.get("p")) ? p.get("p") : "";
  const act = (p.get("act") || "").split(":");
  ov.activity = {
    field: act[0] === "startedAt" ? "startedAt" : "lastAt",
    within: ACTIVITY_WINDOWS.some(([v]) => v === act[1]) ? act[1] : "",
  };
  ov.filters = p.getAll("f").map((tok) => {
    const m = tok.split("~");
    if (m.length < 3) return null;
    return { field: unesc(m[0]), op: m[1], value: unesc(m.slice(2).join("~")) };
  }).filter(Boolean);
  ov.sort = (p.get("s") || "").split(",").filter(Boolean).map((tok) => {
    const dir = tok.startsWith("-") ? -1 : 1;
    return { key: unesc(tok.replace(/^-/, "")), dir };
  });
  const t = tab ? ov.tab[tab] : null;
  if (t) {
    t.page = Math.max(0, Math.floor(Number(p.get("pg")) || 0));
    const n = Number(p.get("n"));
    if (pageSizesFor(tab).includes(n)) t.pageSize = n;
  }
}

const HASH_BASE = { flow: "#flow", rows: "#rows", list: "#list" };
export function syncOvHash(tab) {
  const base = HASH_BASE[tab];
  if (!base) return;
  const qs = serializeOv(tab);
  history.replaceState(null, "", location.pathname + location.search + base + (qs ? "?" + qs : ""));
}

// The query suffix the view switcher appends so hopping tabs keeps the slice.
export function ovQuerySuffix() {
  const qs = serializeOv(null);
  return qs ? "?" + qs : "";
}

// ---------------------------------------------------------------------------
// List columns + By-case gutter attributes (column chooser)
// ---------------------------------------------------------------------------

const SYS_COL_TOKENS = ["$status", "$createdAt", "$updatedAt", "$lastEvent"];
const SYS_COL_META = {
  "$status":   { label: "status", sort: "status" },
  "$createdAt": { label: "created", sort: "createdAt" },
  "$updatedAt": { label: "updated", sort: "updatedAt" },
  "$lastEvent": { label: "last activity", sort: "lastAt" },
  // Not choosable (mandatory, pinned by the List's column plan) but still needs
  // header metadata.
  "$progress": { label: "progress", sort: "progress" },
};

function defaultColTokens(records) {
  return [...attrColumns(records).slice(0, 4), "$status", "$lastEvent"];
}

// The ordered, validated column tokens for the List (ID and Progress are
// rendered unconditionally around these — Progress is mandatory by design).
export function listColTokens(records) {
  const ov = ovState();
  const attrs = new Set(attrColumns(records));
  const toks = (ov.cols ?? defaultColTokens(records)).filter((t) => t !== "$progress" && (SYS_COL_META[t] ? true : attrs.has(t)));
  return toks;
}
export function colMeta(tok) {
  if (SYS_COL_META[tok]) return SYS_COL_META[tok];
  return { label: prettyEntity(tok), sort: "a:" + tok, attr: tok };
}

// First chosen attribute columns drive the By-case gutter labels too (falls
// back to the model's mandatory attributes when the user hasn't customized).
export function chosenGutterAttrs() {
  const ov = ovState();
  if (!ov.cols) return null;
  const attrs = ov.cols.filter((t) => !SYS_COL_META[t]);
  return attrs.length ? attrs.slice(0, 3) : null;
}

// ---------------------------------------------------------------------------
// Toolbar UI
// ---------------------------------------------------------------------------

const OPS = {
  string: [["contains", "contains"], ["eq", "is"], ["neq", "is not"], ["begins", "begins with"]],
  number: [["eq", "="], ["neq", "≠"], ["gte", "≥"], ["lte", "≤"], ["gt", ">"], ["lt", "<"]],
  date:   [["onafter", "on or after"], ["onbefore", "on or before"], ["on", "on"]],
};
function opLabel(type, op) { return (OPS[type] || []).find(([o]) => o === op)?.[1] || op; }
function defaultOp(type) { return type === "number" ? "gte" : type === "date" ? "onafter" : "contains"; }

// Sortable fields offered in the Sort menu (system first, then attributes).
function sortMenuFields() {
  const sys = ["progress", "steps", "lastAt", "startedAt", "createdAt", "updatedAt", "status", "firings", "id"];
  const attrs = _attrKeys.map((k) => "a:" + k);
  return [...sys, ...attrs];
}
// Filterable fields for the field <select>, grouped.
function filterFieldGroups() {
  return [
    ["Progress & status", ["progress", "steps", "total", "firings", "status"]],
    ["Timestamps", ["createdAt", "updatedAt", "startedAt", "lastAt"]],
    ["Identity & activity", ["id", "lastEvent"]],
    ["Attributes", _attrKeys.map((k) => "a:" + k)],
  ];
}

const chipCls = "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 text-xs";
const btnSecondary = "px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50";
const selectCls = "text-sm border border-stone-300 rounded-md px-2 py-1.5 bg-white";

function progChips() {
  const ov = ovState();
  const seg = (val, label, title) => `
    <button type="button" data-ov-prog="${val}" title="${escapeHtml(title)}"
      class="px-2.5 py-1 rounded ${ov.prog === val ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"} whitespace-nowrap transition-colors">${label}</button>`;
  return `
    <div class="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-stone-300 bg-stone-100 text-xs" role="group" aria-label="Progress filter">
      ${seg("", "All", "Every case")}
      ${seg("none", "Not started", "Cases with no fired steps yet")}
      ${seg("active", "In progress", "Cases somewhere mid-flow")}
      ${seg("done", "Done", "Cases that completed their branch")}
    </div>`;
}

// The Activity quick-filter: a dedicated recency dropdown (Started vs Active,
// within the last 24h/7d/30d/3mo/12mo) — the common "what's moved lately?" cut,
// runs through the same engine so it stacks with search, filters and sort.
function activityControl() {
  const ov = ovState();
  const a = ov.activity || { field: "lastAt", within: "" };
  const on = !!a.within;
  const fieldSeg = (val, label, title) => `
    <button type="button" data-ov-actfield="${val}" title="${escapeHtml(title)}"
      class="px-2.5 py-1 rounded ${a.field === val ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"} whitespace-nowrap transition-colors">${label}</button>`;
  const winBtn = (val, label) => `
    <button type="button" data-ov-actwin="${val}"
      class="w-full flex items-center gap-2 px-2 py-1 rounded text-left text-sm ${a.within === val ? "bg-amber-50 text-stone-900" : "hover:bg-stone-50 text-stone-700"}">
      <span class="w-3 text-amber-600">${a.within === val ? "✓" : ""}</span>${escapeHtml(label)}</button>`;
  const singular = prettyEntity(state.meta?.rootAggregate || "case").toLowerCase();
  return `
    <details id="ov-activity" ${ov.ui.activity ? "open" : ""} class="relative">
      <summary class="list-none cursor-pointer select-none px-3 py-1.5 text-sm rounded-md border ${on ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}">
        ${on ? escapeHtml(activityLabel(a)) : "Activity"} <span class="text-stone-400">▾</span>
      </summary>
      <div class="absolute left-0 top-full mt-1 z-40 w-60 rounded-lg border border-stone-200 bg-white shadow-lg p-2 space-y-1">
        <div class="px-1 pb-0.5 text-[11px] text-stone-400">Show ${escapeHtml(singular)}s by when they were…</div>
        <div class="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-stone-300 bg-stone-100 text-xs" role="group" aria-label="Activity field">
          ${fieldSeg("startedAt", "Started", "The case's first (business) event date")}
          ${fieldSeg("lastAt", "Active", "The case's most recent (business) activity")}
        </div>
        <div class="pt-1">
          ${winBtn("", "Any time")}
          ${ACTIVITY_WINDOWS.map(([v, l]) => winBtn(v, l)).join("")}
        </div>
      </div>
    </details>`;
}

function fieldOptions(selected) {
  return filterFieldGroups().map(([label, keys]) => {
    const opts = keys.filter((k) => fieldDef(k)).map((k) =>
      `<option value="${escapeHtml(k)}" ${k === selected ? "selected" : ""}>${escapeHtml(fieldDef(k).label)}</option>`).join("");
    return opts ? `<optgroup label="${escapeHtml(label)}">${opts}</optgroup>` : "";
  }).join("");
}

function filterRow(f, i) {
  const def = fieldDef(f.field) || SYS_FIELDS.progress;
  const type = def.type;
  const ops = OPS[type].map(([op, label]) => `<option value="${op}" ${op === f.op ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
  const inputType = type === "number" ? "number" : type === "date" ? "date" : "text";
  return `
    <div class="flex items-center gap-2">
      <select data-ovf-field="${i}" id="ov-f-field-${i}" class="${selectCls} max-w-[180px]" aria-label="Filter field">${fieldOptions(f.field)}</select>
      <select data-ovf-op="${i}" id="ov-f-op-${i}" class="${selectCls}" aria-label="Filter condition">${ops}</select>
      <input data-ovf-val="${i}" id="ov-f-val-${i}" type="${inputType}" ${inputType === "number" ? `step="any"` : ""} value="${escapeHtml(f.value ?? "")}"
        placeholder="value" class="flex-1 min-w-0 text-sm border border-stone-300 rounded-md px-2 py-1.5" aria-label="Filter value" />
      <button type="button" data-ovf-del="${i}" class="p-1 text-stone-400 hover:text-rose-600" title="Remove this filter">✕</button>
    </div>`;
}

function filtersControl() {
  const ov = ovState();
  const active = ov.filters.filter((f) => String(f.value ?? "") !== "").length;
  const rows = ov.filters.map((f, i) => filterRow(f, i)).join("");
  return `
    <details id="ov-filters" ${ov.ui.filters ? "open" : ""} class="relative">
      <summary class="list-none cursor-pointer select-none px-3 py-1.5 text-sm rounded-md border ${active ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}">
        Filters${active ? ` · ${active}` : ""} <span class="text-stone-400">▾</span>
      </summary>
      <div class="absolute left-0 top-full mt-1 z-40 w-[34rem] max-w-[90vw] rounded-lg border border-stone-200 bg-white shadow-lg p-3 space-y-2">
        ${rows || `<div class="text-sm text-stone-400">No filters yet — add one below. Filters combine with the search box, the progress chips and each other (AND).</div>`}
        <div class="flex items-center gap-3 pt-1">
          <button type="button" id="ov-f-add" class="${btnSecondary}">+ Add filter</button>
          ${ov.filters.length ? `<button type="button" id="ov-f-clear" class="text-sm text-sky-700 hover:underline">Clear filters</button>` : ""}
        </div>
      </div>
    </details>`;
}

function sortControl(tab) {
  const ov = ovState();
  const items = sortMenuFields().map((key) => {
    const def = fieldDef(key);
    if (!def) return "";
    const idx = ov.sort.findIndex((s) => s.key === key);
    const on = idx >= 0;
    const dir = on ? ov.sort[idx].dir : 0;
    const badge = on
      ? `<span class="ml-auto inline-flex items-center gap-1 text-amber-700">${ov.sort.length > 1 ? `<span class="text-[10px] tabular-nums">${idx + 1}</span>` : ""}${dir === -1 ? "▼" : "▲"}</span>`
      : "";
    return `
      <button type="button" data-ov-sortkey="${escapeHtml(key)}"
        class="w-full flex items-center gap-2 px-2 py-1 rounded text-left text-sm ${on ? "bg-amber-50 text-stone-900" : "hover:bg-stone-50 text-stone-700"}">
        ${escapeHtml(def.label)}${badge}
      </button>`;
  }).join("");
  return `
    <details id="ov-sort" ${ov.ui.sort ? "open" : ""} class="relative">
      <summary class="list-none cursor-pointer select-none px-3 py-1.5 text-sm rounded-md border ${ov.sort.length ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}">
        Sort${ov.sort.length ? ` · ${ov.sort.length}` : ""} <span class="text-stone-400">▾</span>
      </summary>
      <div class="absolute left-0 top-full mt-1 z-40 w-64 rounded-lg border border-stone-200 bg-white shadow-lg p-2 max-h-[60vh] overflow-auto">
        <div class="px-2 pb-1 text-[11px] text-stone-400">Click to sort · again to flip · third click removes. Levels stack in click order${tab === "list" ? "; shift-click a column header does the same" : ""}.</div>
        ${items}
      </div>
    </details>`;
}

function colsControl(records) {
  const ov = ovState();
  const chosen = new Set(listColTokens(records));
  const mand = (label) => `
    <label class="flex items-center gap-2 px-2 py-1 text-sm text-stone-400" title="Always shown">
      <input type="checkbox" checked disabled class="accent-stone-400" /> ${label} <span class="ml-auto text-[10px] uppercase tracking-wide">always</span>
    </label>`;
  const opt = (tok, label) => `
    <label class="flex items-center gap-2 px-2 py-1 rounded text-sm text-stone-700 hover:bg-stone-50 cursor-pointer">
      <input type="checkbox" data-ov-col="${escapeHtml(tok)}" ${chosen.has(tok) ? "checked" : ""} class="accent-amber-500" /> ${escapeHtml(label)}
    </label>`;
  const attrOpts = _attrKeys.map((k) => opt(k, prettyEntity(k))).join("");
  const sysOpts = SYS_COL_TOKENS.map((t) => opt(t, SYS_COL_META[t].label)).join("");
  return `
    <details id="ov-cols" ${ov.ui.cols ? "open" : ""} class="relative">
      <summary class="list-none cursor-pointer select-none px-3 py-1.5 text-sm rounded-md border ${ov.cols ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}">
        Columns <span class="text-stone-400">▾</span>
      </summary>
      <div class="absolute right-0 top-full mt-1 z-40 w-64 rounded-lg border border-stone-200 bg-white shadow-lg p-2 max-h-[60vh] overflow-auto">
        ${mand("id")}${mand("progress")}
        ${attrOpts ? `<div class="px-2 pt-1 text-[10px] uppercase tracking-wide text-stone-400">Attributes</div>${attrOpts}` : ""}
        <div class="px-2 pt-1 text-[10px] uppercase tracking-wide text-stone-400">System</div>${sysOpts}
        ${ov.cols ? `<div class="px-2 pt-2"><button type="button" id="ov-cols-reset" class="text-sm text-sky-700 hover:underline">Reset to defaults</button></div>` : ""}
      </div>
    </details>`;
}

// Dismissible chips for everything currently narrowing/ordering the view.
function activeChips() {
  const ov = ovState();
  const chips = [];
  if (ov.prog) chips.push(`<span class="${chipCls}">${PROG_LABEL[ov.prog]}<button type="button" data-ov-prog="" title="Show all progress states">✕</button></span>`);
  if (ov.activity?.within) chips.push(`<span class="${chipCls}" title="Clear the activity window">${escapeHtml(activityLabel(ov.activity))}<button type="button" data-ov-actwin="">✕</button></span>`);
  ov.filters.forEach((f, i) => {
    if (String(f.value ?? "") === "") return;
    const def = fieldDef(f.field);
    if (!def) return;
    chips.push(`<span class="${chipCls}" title="Remove this filter">${escapeHtml(def.label)} ${escapeHtml(opLabel(def.type, f.op))} ${escapeHtml(String(f.value))}<button type="button" data-ovf-del="${i}">✕</button></span>`);
  });
  ov.sort.forEach((s, i) => {
    const def = fieldDef(s.key);
    if (!def) return;
    chips.push(`<span class="${chipCls} !bg-sky-50 !border-sky-200 !text-sky-900" title="Click the arrow to flip, ✕ to remove">
      ${ov.sort.length > 1 ? `<span class="tabular-nums text-[10px]">${i + 1}</span>` : ""}${escapeHtml(def.label)}
      <button type="button" data-ov-sortflip="${escapeHtml(s.key)}" class="font-semibold">${s.dir === -1 ? "▼" : "▲"}</button>
      <button type="button" data-ov-sortdel="${escapeHtml(s.key)}">✕</button></span>`);
  });
  return chips.length ? `<div class="flex flex-wrap items-center gap-1.5 w-full pt-1">${chips.join("")}</div>` : "";
}

// The toolbar block, rendered directly under each tab's sticky header.
// `tab` ∈ "list" | "rows" | "flow". Flow gets search/filters only (sorting and
// paging don't apply to a merged diagram).
export function ovToolbar(tab, records, res) {
  const ov = ovState();
  ensureFields(records);
  const showSort = tab !== "flow";
  const anyState = ovActive() || ov.sort.length > 0;
  const count = res
    ? (ovActive()
        ? `<span class="text-xs text-stone-500 tabular-nums whitespace-nowrap">${res.total.toLocaleString()} of ${records.length.toLocaleString()} match</span>`
        : `<span class="text-xs text-stone-400 tabular-nums whitespace-nowrap">${records.length.toLocaleString()} case${records.length === 1 ? "" : "s"}</span>`)
    : "";
  return `
    <div class="px-6 py-2.5 bg-white border-b border-stone-200 flex flex-wrap items-center gap-2" id="ov-toolbar">
      <div class="relative">
        <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 text-sm pointer-events-none">⌕</span>
        <input id="ov-search" type="search" value="${escapeHtml(ov.q)}" placeholder="Search ${escapeHtml(prettyEntity(state.meta?.rootAggregatePlural || "cases").toLowerCase())}…  ( / )"
          autocomplete="off" spellcheck="false"
          class="w-64 text-sm border border-stone-300 rounded-md pl-8 pr-7 py-1.5 focus:border-amber-400 focus:outline-none" aria-label="Free-text search across every attribute" />
        ${ov.q ? `<button type="button" id="ov-search-clear" class="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700" title="Clear search">✕</button>` : ""}
      </div>
      ${progChips()}
      ${activityControl()}
      ${filtersControl()}
      ${showSort ? sortControl(tab) : ""}
      ${anyState ? `<button type="button" id="ov-clear" class="text-sm text-sky-700 hover:underline whitespace-nowrap" title="Clear search, filters and sorting">Reset</button>` : ""}
      <div class="ml-auto flex items-center gap-3">
        ${count}
        ${tab === "list" ? colsControl(records) : ""}
      </div>
      ${activeChips()}
    </div>`;
}

// Pager control — shared by the List footer and the By-case banner.
export function ovPager(tab, res) {
  const ov = ovState();
  const t = ov.tab[tab];
  if (!t) return "";
  const btn = (act, label, disabled, title) => `
    <button type="button" data-ov-page="${act}" ${disabled ? "disabled" : ""} title="${escapeHtml(title)}"
      class="px-2 py-0.5 rounded hover:bg-stone-100 ${disabled ? "opacity-40 cursor-default" : ""}">${label}</button>`;
  const sizes = pageSizesFor(tab).map((n) => `<option value="${n}" ${n === t.pageSize ? "selected" : ""}>${n}</option>`).join("");
  return `
    <div class="flex items-center gap-2 text-sm text-stone-600">
      <label class="flex items-center gap-1.5 text-xs text-stone-500">Per page
        <select id="ov-pagesize" class="${selectCls} !py-0.5 text-xs">${sizes}</select>
      </label>
      <span class="tabular-nums text-xs text-stone-500 whitespace-nowrap">${res.from.toLocaleString()}–${res.to.toLocaleString()} of ${res.total.toLocaleString()}</span>
      ${btn("first", "«", res.page === 0, "First page")}
      ${btn("prev", "‹", res.page === 0, "Previous page")}
      <span class="tabular-nums text-xs whitespace-nowrap">${res.page + 1} / ${res.pages}</span>
      ${btn("next", "›", res.page >= res.pages - 1, "Next page")}
      ${btn("last", "»", res.page >= res.pages - 1, "Last page")}
    </div>`;
}

// Sortable header cell for the List table. Click = sort by this column
// (toggling direction); shift-click = stack it as an extra level.
export function sortableTh(sortKey, label, extraCls = "") {
  const ov = ovState();
  const idx = ov.sort.findIndex((s) => s.key === sortKey);
  const on = idx >= 0;
  const dir = on ? ov.sort[idx].dir : 0;
  const aria = on ? (dir === -1 ? "descending" : "ascending") : "none";
  const ind = on
    ? `<span class="text-amber-600">${ov.sort.length > 1 ? `<sup class="tabular-nums">${idx + 1}</sup>` : ""}${dir === -1 ? "▼" : "▲"}</span>`
    : `<span class="opacity-0 group-hover/th:opacity-40">▲</span>`;
  return `
    <th class="px-4 py-2 font-medium ${extraCls}" aria-sort="${aria}">
      <button type="button" data-ov-th="${escapeHtml(sortKey)}" title="Sort by ${escapeHtml(label)} — click again to flip; shift-click to stack sort levels"
        class="group/th inline-flex items-center gap-1 uppercase tracking-wide hover:text-stone-800 cursor-pointer">${escapeHtml(label)} ${ind}</button>
    </th>`;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

let _debounce = null;
function requery(tab, { resetPage = true } = {}) {
  const ov = ovState();
  if (resetPage && ov.tab[tab]) ov.tab[tab].page = 0;
  syncOvHash(tab);
  render();
}
function requeryDebounced(tab, opts) {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => requery(tab, opts), 180);
}

// Default sort direction on first activation: newest/biggest first for dates
// and numbers, A→Z for text.
function naturalDir(key) {
  const def = fieldDef(key);
  return def && (def.type === "date" || def.type === "number") ? -1 : 1;
}
function cycleSort(key, { stack }) {
  const ov = ovState();
  const idx = ov.sort.findIndex((s) => s.key === key);
  if (idx === -1) {
    if (!stack) ov.sort = [];
    ov.sort.push({ key, dir: naturalDir(key) });
  } else if (ov.sort[idx].dir === naturalDir(key)) {
    if (!stack && ov.sort.length > 1) ov.sort = [{ key, dir: naturalDir(key) }]; // header click on a stacked level: promote first
    else ov.sort[idx].dir = -ov.sort[idx].dir;
  } else {
    ov.sort.splice(idx, 1);
  }
}

let _keysReady = false;
export function bindOvToolbar(tab) {
  const ov = ovState();

  // Search — quiet state update + debounced re-render (the input keeps focus
  // across render() via its stable id + captureFocus/restoreFocus).
  const search = document.getElementById("ov-search");
  search?.addEventListener("input", () => { ov.q = search.value; requeryDebounced(tab); });
  document.getElementById("ov-search-clear")?.addEventListener("click", () => { ov.q = ""; requery(tab); });

  // Progress chips (also the chip-row ✕ which reuses data-ov-prog="").
  document.querySelectorAll("[data-ov-prog]").forEach((el) => {
    el.addEventListener("click", () => { ov.prog = el.dataset.ovProg || ""; requery(tab); });
  });

  // Activity recency filter: field toggle + window buttons (the chip-row ✕
  // reuses data-ov-actwin="").
  document.querySelectorAll("[data-ov-actfield]").forEach((el) => {
    el.addEventListener("click", () => { ov.activity.field = el.dataset.ovActfield === "startedAt" ? "startedAt" : "lastAt"; ov.ui.activity = true; requery(tab); });
  });
  document.querySelectorAll("[data-ov-actwin]").forEach((el) => {
    el.addEventListener("click", () => { ov.activity.within = el.dataset.ovActwin || ""; ov.ui.activity = true; requery(tab); });
  });

  // Dropdown open-state survives re-renders via ov.ui.
  for (const [id, key] of [["ov-filters", "filters"], ["ov-activity", "activity"], ["ov-sort", "sort"], ["ov-cols", "cols"]]) {
    const d = document.getElementById(id);
    d?.addEventListener("toggle", () => { ov.ui[key] = d.open; });
  }

  // Filters.
  document.getElementById("ov-f-add")?.addEventListener("click", () => {
    ov.filters.push({ field: "progress", op: defaultOp("number"), value: "" });
    ov.ui.filters = true;
    requery(tab);
    setTimeout(() => document.getElementById(`ov-f-val-${ov.filters.length - 1}`)?.focus(), 30);
  });
  document.getElementById("ov-f-clear")?.addEventListener("click", () => { ov.filters = []; requery(tab); });
  document.querySelectorAll("[data-ovf-field]").forEach((el) => {
    el.addEventListener("change", () => {
      const i = Number(el.dataset.ovfField);
      const f = ov.filters[i]; if (!f) return;
      f.field = el.value;
      f.op = defaultOp(fieldDef(f.field)?.type || "string");
      f.value = "";
      ov.ui.filters = true;
      requery(tab);
      setTimeout(() => document.getElementById(`ov-f-val-${i}`)?.focus(), 30);
    });
  });
  document.querySelectorAll("[data-ovf-op]").forEach((el) => {
    el.addEventListener("change", () => {
      const f = ov.filters[Number(el.dataset.ovfOp)]; if (!f) return;
      f.op = el.value; requery(tab);
    });
  });
  document.querySelectorAll("[data-ovf-val]").forEach((el) => {
    el.addEventListener("input", () => {
      const f = ov.filters[Number(el.dataset.ovfVal)]; if (!f) return;
      f.value = el.value;
      el.type === "text" || el.type === "number" ? requeryDebounced(tab) : requery(tab);
    });
  });
  document.querySelectorAll("[data-ovf-del]").forEach((el) => {
    el.addEventListener("click", () => { ov.filters.splice(Number(el.dataset.ovfDel), 1); requery(tab); });
  });

  // Sort — menu, chips, header clicks.
  document.querySelectorAll("[data-ov-sortkey]").forEach((el) => {
    el.addEventListener("click", () => { ov.ui.sort = true; cycleSort(el.dataset.ovSortkey, { stack: true }); requery(tab); });
  });
  document.querySelectorAll("[data-ov-sortflip]").forEach((el) => {
    el.addEventListener("click", () => {
      const s = ov.sort.find((x) => x.key === el.dataset.ovSortflip);
      if (s) { s.dir = -s.dir; requery(tab); }
    });
  });
  document.querySelectorAll("[data-ov-sortdel]").forEach((el) => {
    el.addEventListener("click", () => {
      ov.sort = ov.sort.filter((x) => x.key !== el.dataset.ovSortdel); requery(tab);
    });
  });
  document.querySelectorAll("[data-ov-th]").forEach((el) => {
    el.addEventListener("click", (ev) => cycleThenRequery(ev, el, tab));
  });

  // Reset everything except column choices and page-size prefs.
  document.getElementById("ov-clear")?.addEventListener("click", () => {
    ov.q = ""; ov.prog = ""; ov.filters = []; ov.sort = [];
    ov.activity = { field: "lastAt", within: "" };
    requery(tab);
  });

  // Columns (List only).
  document.querySelectorAll("[data-ov-col]").forEach((el) => {
    el.addEventListener("change", () => {
      const records = caseRecords();
      const cur = listColTokens(records);
      const tok = el.dataset.ovCol;
      let next = el.checked ? [...cur, tok] : cur.filter((t) => t !== tok);
      // Keep a stable, sensible order: attributes in model order, then system.
      const order = [...attrColumns(records), ...SYS_COL_TOKENS];
      next = order.filter((t) => next.includes(t));
      ov.cols = next;
      setPref("cols", next);
      ov.ui.cols = true;
      requery(tab, { resetPage: false });
    });
  });
  document.getElementById("ov-cols-reset")?.addEventListener("click", () => {
    ov.cols = null; setPref("cols", null); ov.ui.cols = true; requery(tab, { resetPage: false });
  });

  // Pager.
  document.querySelectorAll("[data-ov-page]").forEach((el) => {
    el.addEventListener("click", () => {
      const t = ov.tab[tab]; if (!t) return;
      const act = el.dataset.ovPage;
      if (act === "first") t.page = 0;
      else if (act === "prev") t.page = Math.max(0, t.page - 1);
      else if (act === "next") t.page = t.page + 1; // applyQuery snaps overflow back
      else if (act === "last") t.page = Number.MAX_SAFE_INTEGER; // snapped to the real last page
      requery(tab, { resetPage: false });
    });
  });
  document.getElementById("ov-pagesize")?.addEventListener("change", (ev) => {
    const t = ov.tab[tab]; if (!t) return;
    t.pageSize = normPageSize(Number(ev.target.value), tab);
    t.page = 0;
    setPref(`${tab}.pageSize`, t.pageSize);
    requery(tab);
  });

  // "/" focuses search on any Overview tab; Escape in the search clears it.
  // Clicking outside an open toolbar dropdown closes it (the details' toggle
  // listener keeps ov.ui in sync, so the next render agrees).
  if (!_keysReady) {
    _keysReady = true;
    document.addEventListener("click", (ev) => {
      // A click on a control that re-rendered (e.g. "+ Add filter") leaves its
      // target detached; the freshly-built DOM already reflects ov.ui, so don't
      // second-guess it — otherwise we'd close the dropdown we just reopened.
      if (!ev.target.isConnected) return;
      for (const id of ["ov-filters", "ov-activity", "ov-sort", "ov-cols"]) {
        const d = document.getElementById(id);
        if (d && d.open && !d.contains(ev.target)) d.open = false;
      }
    });
    document.addEventListener("keydown", (ev) => {
      const t2 = ovTabForView(state.view);
      if (!t2) return;
      const el = document.activeElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (ev.key === "/" && !typing) {
        const s = document.getElementById("ov-search");
        if (s) { ev.preventDefault(); s.focus(); s.select(); }
      } else if (ev.key === "Escape" && el && el.id === "ov-search") {
        if (ovState().q) { ovState().q = ""; requery(t2); }
        el.blur();
      }
    });
  }
}

function cycleThenRequery(ev, el, tab) {
  cycleSort(el.dataset.ovTh, { stack: ev.shiftKey });
  requery(tab);
}

// Compact absolute stamp for Created/Updated cells.
export function fmtStamp(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
