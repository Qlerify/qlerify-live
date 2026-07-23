// Per-case detail view — the SVG event timeline, flow layout, branch split,
// as-of scrubbing, and the model-generic reconstructed data panels. Extracted
// from app.js (the largest view module).
import { state } from "./state.js";
import { escapeHtml, prettyEntity } from "./format.js";
import { provChip, provHatch, provModeForBC } from "./chips.js";
import { STATUS_TONE, PHASE_TONE, api, navigate, render } from "./app.js";
import { attrText, genericColumns, loadFlowRows, loadMeta } from "./dashboard.js";
import { loadRegistryStatus } from "./model.js";

// ---------------------------------------------------------------------------
// Detail view — model-generic relationship forest (genericDetailView)
// ---------------------------------------------------------------------------

export async function loadDetail() {
  await loadMeta();
  // Per-run detail from the model-generic simulator.
  const [instance, events, cur] = await Promise.all([
    api("/sim/instance/" + encodeURIComponent(state.caseId)),
    api("/sim/events"),
    api("/sim/current-step?caseId=" + encodeURIComponent(state.caseId)),
    loadRegistryStatus(),
  ]);
  // Keep the pre-step instance so the detail view can mark what this step
  // changed. Only diff within the same run — switching runs starts clean.
  state.prevInstance = state.instance && state.instance.instanceId === instance.instanceId ? state.instance : null;
  // New run (not just a step within the same run) → collapse any expanded
  // fired-count badges and any active branch split so the next case starts clean.
  if (state.prevInstance === null) { state.expandedFirings = new Set(); state.splitRef = null; state.selectedStep = null; }
  state.instance = instance;
  state.events = events;
  // newest-first so lastEventInline() / businessByStep read the latest first
  // (the Event log tab reverses it back to chronological order).
  state.log = (instance.events || []).slice().reverse();
  state.currentIndex = cur.index;
  render();
}

export async function doNext() {
  if (state.busy) return;
  state.selectedStep = null; // advancing the live run drops any as-of scrub
  state.busy = true; render();
  try {
    await api("/sim/next", {
      method: "POST",
      body: JSON.stringify({ caseId: state.caseId }),
    });
    await loadDetail();
  } catch (e) {
    alert(e.message);
  } finally {
    state.busy = false; render();
  }
}

export async function doRunAll() {
  if (state.busy) return;
  state.selectedStep = null; // advancing the live run drops any as-of scrub
  state.busy = true; render();
  try {
    await api("/sim/run-all", {
      method: "POST",
      body: JSON.stringify({ caseId: state.caseId }),
    });
    await loadDetail();
  } catch (e) {
    alert(e.message);
  } finally {
    state.busy = false; render();
  }
}

export async function doReset() {
  if (state.busy) return;
  if (!confirm("Reset this case and start over?")) return;
  state.busy = true; render();
  try {
    await api("/sim/reset", { method: "POST", body: JSON.stringify({ caseId: state.caseId }) });
    // case was deleted; go back to dashboard
    navigate("#");
  } finally {
    state.busy = false;
  }
}

export function pill(text, status) {
  const tone = STATUS_TONE[status] || "bg-stone-100 text-stone-700";
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${tone}">${text}</span>`;
}

export function shortId(id) {
  if (!id) return "—";
  return String(id).length > 14 ? String(id).slice(0, 8) + "…" : id;
}

// Build a per-step lookup of the businessAt timestamp recorded when each step fired.
export function businessByStep() {
  const m = new Map(); // eventRef → ISO businessAt
  for (const entry of state.log) {
    if (entry.businessAt && !m.has(entry.eventRef)) m.set(entry.eventRef, entry.businessAt);
  }
  return m;
}

// The set of event refs that actually fired for the loaded instance (from the
// event log) — the gap-safe basis for "which steps are done". A derived run fires
// a non-contiguous subset, so step state must come from here, not a linear cursor.
export function firedRefSet() {
  return new Set((state.log || []).map((entry) => entry.eventRef));
}

// How many times each event ref fired for the loaded instance — one log entry
// per firing, so an event replayed 10× (e.g. Project Created) maps to 10. Used
// to surface a "×N" multiplier on the card without adding a row.
export function firedCountMap() {
  const counts = new Map();
  for (const entry of state.log || []) {
    counts.set(entry.eventRef, (counts.get(entry.eventRef) || 0) + 1);
  }
  return counts;
}

// All firings of each event ref for the loaded case, oldest → newest. state.log
// is newest-first, so prepending while iterating yields chronological order.
// Each entry keeps its own businessAt/payload/evidence, so an expanded card can
// give every firing its own row.
export function firingsByRefMap() {
  const m = new Map(); // ref → [entry, …] oldest→newest
  for (const entry of state.log || []) {
    if (!m.has(entry.eventRef)) m.set(entry.eventRef, []);
    m.get(entry.eventRef).unshift(entry);
  }
  return m;
}

// Rendered height (px) of a card whose ×N badge is expanded into one row per
// firing. A header band (context/name/role + paddings) plus a slim row per
// firing; the lane reflow uses this to push lower lanes down. Always taller than
// a collapsed card (cardH 104) for any n ≥ 2.
export const FIRING_ROW_H = 16;
export function expandedCardHeight(n) {
  return 84 + n * FIRING_ROW_H + 26; // +26 leaves room for the "Split into branches" button
}

// High-salience corner badge: a filled emerald bubble overlapping the card's
// top-right corner, showing "×N" when an event fired more than once for this
// case. Rendered as a SIBLING of the cards (not a child) so it can overhang the
// card edge — the card itself clips children via overflow-hidden. (cx, cy) is the
// card's top-right corner in the flow container; the translate centres the bubble
// on that point. Hidden at 1 so the common single-firing case stays clean.
// Clickable: toggles per-firing expansion for `ref` (push-down reflow). When
// open it reads as pressed (amber ring) so the affordance to collapse is clear.
export function firedCountBadge(ref, n, cx, cy, isOpen) {
  if (!n || n <= 1) return "";
  const ring = isOpen ? "ring-amber-400" : "ring-white";
  return `<div data-toggle-firings="${ref}" role="button" tabindex="0"
       class="absolute z-10 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-none shadow ring-2 ${ring} cursor-pointer hover:bg-emerald-600"
       style="left:${cx}px; top:${cy}px; transform:translate(-50%,-50%); min-width:20px; height:18px; padding:0 5px;"
       title="${isOpen ? "Click to collapse" : "Fired " + n + "× for this case — click to expand each firing into its own row"}">×${n}</div>`;
}

// Non-interactive twin of firedCountBadge for the aggregate views (merged flow,
// by-case rows): the SAME emerald "×N" corner bubble, hidden at n≤1, just without
// the click-to-expand affordance (there are no per-firing rows to expand there).
// Keeping one look means the badge reads identically across detail / merged / by
// case. (cx, cy) is the card's top-right corner; the translate centres it.
export function flowCountBadge(n, cx, cy, title) {
  if (!n || n <= 1) return "";
  return `<div class="absolute z-10 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-none shadow ring-2 ring-white"
       style="left:${cx}px; top:${cy}px; transform:translate(-50%,-50%); min-width:20px; height:18px; padding:0 5px;"
       title="${escapeHtml(title || ("Fired " + n + "×"))}">×${n}</div>`;
}

// Readable business date. Rendered in UTC so it's stable regardless of the
// viewer's timezone (the businessAt value is a date carried in the event data).
export function fmtBizDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function minutesBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  return Math.round((new Date(isoB).getTime() - new Date(isoA).getTime()) / 60_000);
}

// Compact elapsed-time label for the gap between two fired steps: minutes within
// the hour, hours within the day, days beyond (+30m, +2h, +9h, +14d) — so the
// timeline reads naturally whether a model's steps are minutes or weeks apart.
export function fmtGap(min) {
  if (min < 60) return `+${min}m`;
  const h = Math.floor(min / 60), mm = min % 60;
  if (h < 24) return mm ? `+${h}h${mm}m` : `+${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `+${d}d${hh}h` : `+${d}d`;
}

// Human "how long ago" for a past ISO timestamp: "just now", "5m ago", "2h ago",
// "3d ago", "4mo ago", "1y ago". Pairs with the absolute date in the by-case
// gutter so a row reads "Jun 28, 14:05 · 5m ago".
export function timeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// Small inline icons for the by-case copy-id control (currentColor so they tint
// with the button's text colour).
export const iconCopy = `<svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const iconCheck = `<svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------------------
// Flow layout — turn the event DAG (each event's `predecessors`, the model's
// `follows` edges) into a 2-D placement:
//   • column = longest-path depth from a start event, so events that run in
//     parallel line up vertically in the same column;
//   • lane (row) = the longest path through the graph is the "main spine" and
//     stays on the top lane (0); every branch that forks off it drops to the
//     next free lane below and runs in its own row until it ends.
// A model with no `follows` edges (or a plain chain) collapses to one lane —
// i.e. the original single-row timeline, so nothing regresses for linear flows.
// ---------------------------------------------------------------------------
export function computeFlowLayout(events) {
  const byRef = new Map();
  events.forEach((e, idx) => byRef.set(e.ref, { event: e, idx }));
  const preds = (ref) => (byRef.get(ref)?.event.predecessors || []).filter((p) => byRef.has(p));

  // No edges at all (linear model, or a server that predates `predecessors`) →
  // fall back to a single lane in declared order.
  if (!events.some((e) => preds(e.ref).length > 0)) {
    const place = new Map(events.map((e, i) => [e.ref, { col: i, lane: 0, idx: i }]));
    return { cols: events.length, lanes: 1, place, edges: [] };
  }

  const succ = new Map(events.map((e) => [e.ref, []]));
  for (const e of events) for (const p of preds(e.ref)) succ.get(p).push(e.ref);

  // col = longest path from a source (memoized); height = longest path to a sink.
  const colMemo = new Map();
  const col = (ref) => {
    if (colMemo.has(ref)) return colMemo.get(ref);
    const ps = preds(ref);
    const c = ps.length ? 1 + Math.max(...ps.map(col)) : 0;
    colMemo.set(ref, c);
    return c;
  };
  const hMemo = new Map();
  const height = (ref) => {
    if (hMemo.has(ref)) return hMemo.get(ref);
    const ss = succ.get(ref) || [];
    const h = ss.length ? 1 + Math.max(...ss.map(height)) : 0;
    hMemo.set(ref, h);
    return h;
  };
  events.forEach((e) => { col(e.ref); height(e.ref); });

  // Main spine: start at the source that begins the longest path, then walk
  // forward. At each fork, prefer a "shortcut" successor — an edge that skips one
  // or more columns (col advance > 1) — so the direct line stays on the top lane
  // and the skipped sub-process drops to a branch below it. (e.g. a model with a
  // direct "GPR Implemented → GPR Deployed" edge plus a longer "exemption" detour
  // keeps the direct edge straight on the spine and pushes the detour down.) With
  // no shortcut at the fork, fall back to the successor with the most depth
  // remaining, as before — so plain parallel branches still spine the longest path.
  const spine = new Set();
  const sources = events.filter((e) => preds(e.ref).length === 0).map((e) => e.ref);
  if (sources.length) {
    let cur = sources.reduce((a, b) => (height(b) > height(a) ? b : a));
    while (cur) {
      spine.add(cur);
      const ss = succ.get(cur) || [];
      if (!ss.length) break;
      const cc = col(cur);
      const shortcuts = ss.filter((s) => col(s) - cc > 1);
      cur = shortcuts.length
        ? shortcuts.reduce((a, b) => (col(b) > col(a) ? b : a))
        : ss.reduce((a, b) => (height(b) > height(a) ? b : a));
    }
  }

  // Lanes: spine on lane 0; every other event is grouped into a branch and each
  // branch laid out as a coherent horizontal band below the spine.
  //
  // A branch is a weakly-connected group of non-spine events (linked through
  // their non-spine predecessor edges). Branches are placed shortest-span first,
  // so a small sub-branch that forks off the spine and quickly merges back claims
  // the lane nearest the spine, while a longer branch that forked earlier is
  // pushed further down. That keeps the short branch's fork/merge connectors from
  // crossing over the long one — e.g. the GPR exemption detour sits on the row
  // right under the spine and the wider BR branch drops below it. Assigning a
  // whole branch one base lane (rather than node-by-node) also stops a branch
  // from zig-zagging when a later branch needs the inner lane.
  const lane = new Map();
  const occupied = new Set(); // "lane,col"
  for (const ref of spine) { lane.set(ref, 0); occupied.add(`0,${col(ref)}`); }

  const nonSpine = events.filter((e) => !spine.has(e.ref)).map((e) => e.ref);
  const adj = new Map(nonSpine.map((r) => [r, []]));
  for (const r of nonSpine) {
    for (const p of preds(r)) if (adj.has(p)) { adj.get(r).push(p); adj.get(p).push(r); }
  }
  const seen = new Set();
  const branches = [];
  for (const r of nonSpine) {
    if (seen.has(r)) continue;
    const members = [];
    const stack = [r];
    seen.add(r);
    while (stack.length) {
      const x = stack.pop();
      members.push(x);
      for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }
    const cs = members.map(col);
    branches.push({ members, minCol: Math.min(...cs), maxCol: Math.max(...cs) });
  }
  // Narrowest column span first → nearest the spine; ties to the later fork
  // (higher minCol), then declared order, so nesting reads inside-out.
  branches.sort((a, b) =>
    (a.maxCol - a.minCol) - (b.maxCol - b.minCol) ||
    b.minCol - a.minCol ||
    byRef.get(a.members[0]).idx - byRef.get(b.members[0]).idx);
  for (const br of branches) {
    // Lowest base lane free across every column the branch occupies, so a chain
    // branch lands on one clean row; an internal fork drops the extra node below.
    const cs = br.members.map(col);
    let base = 1;
    while (cs.some((c) => occupied.has(`${base},${c}`))) base++;
    const ordered = br.members.slice()
      .sort((a, b) => col(a) - col(b) || byRef.get(a).idx - byRef.get(b).idx);
    for (const ref of ordered) {
      const c = col(ref);
      let L = base;
      while (occupied.has(`${L},${c}`)) L++;
      lane.set(ref, L);
      occupied.add(`${L},${c}`);
    }
  }

  const place = new Map(events.map((e) => [e.ref, { col: col(e.ref), lane: lane.get(e.ref), idx: byRef.get(e.ref).idx }]));
  const cols = Math.max(...events.map((e) => col(e.ref))) + 1;
  const edges = [];
  for (const e of events) for (const p of preds(e.ref)) edges.push({ from: p, to: e.ref });

  // Route long edges around the cards they fly over. An edge that spans more
  // than one column (e.g. a fork that also jumps straight to a downstream merge,
  // so two branches run between the same pair of events) would otherwise be
  // drawn as a flat line straight through the cards sitting in the columns
  // between its ends. Give each such edge a "waypoint row" — the lowest lane
  // that is free in every column it crosses, adding a fresh row below when none
  // is — so it bows into its own row instead of overlapping those cards. Short
  // (adjacent-column) edges need no row and keep the original direct curve, so
  // linear flows produce no waypoints and the single-lane timeline is unchanged.
  const waypoints = new Map(); // `${from}->${to}` -> { lane, cols }
  let maxLane = events.reduce((m, e) => Math.max(m, lane.get(e.ref)), 0);
  const longEdges = edges
    .map((e) => ({ ...e, c0: col(e.from), c1: col(e.to) }))
    .filter((e) => e.c1 - e.c0 > 1)
    .sort((a, b) => (b.c1 - b.c0) - (a.c1 - a.c0)); // widest first → big arcs claim rows first
  for (const e of longEdges) {
    const mid = [];
    for (let c = e.c0 + 1; c < e.c1; c++) mid.push(c);
    // If both ends sit on the same lane and that lane is clear across every
    // column the edge spans, it can run dead straight along its own lane — no
    // need to bow it onto a routed row. This is what keeps a spine shortcut (e.g.
    // GPR Implemented → GPR Deployed) a straight horizontal line once the skipped
    // steps have dropped to lower lanes. Claim those cells so a later routed edge
    // can't overlap the straight run.
    const lf = lane.get(e.from), lt = lane.get(e.to);
    if (lf === lt && mid.every((c) => !occupied.has(`${lf},${c}`))) {
      mid.forEach((c) => occupied.add(`${lf},${c}`));
      continue;
    }
    let L = 1;
    while (!mid.every((c) => !occupied.has(`${L},${c}`))) L++;
    mid.forEach((c) => occupied.add(`${L},${c}`));
    maxLane = Math.max(maxLane, L);
    waypoints.set(`${e.from}->${e.to}`, { lane: L, cols: mid });
  }
  const lanes = maxLane + 1;
  return { cols, lanes, place, edges, waypoints };
}

// Connector path for one edge between two placed cards. Adjacent-column edges
// get the original smooth S-curve; an edge with a waypoint row (see
// computeFlowLayout) eases into that free row, runs flat across the columns it
// spans, then climbs to the target — so it never crosses the cards in between.
// Endpoints stay anchored to each card's header band (top + cardH/2) as before,
// even when a card is expanded tall; only the mid-run drops to the route row.
export function flowEdgePath(a, b, wp, laneTop, laneHeight, geom) {
  const { cardW, cardH, colPitch } = geom;
  const sx = a.col * colPitch + cardW, sy = laneTop[a.lane] + cardH / 2;
  const ex = b.col * colPitch,         ey = laneTop[b.lane] + cardH / 2;
  if (!wp) {
    const dx = Math.max(24, (ex - sx) * 0.5);
    return `M${sx},${sy} C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`;
  }
  const ry = laneTop[wp.lane] + laneHeight[wp.lane] / 2; // centre of the waypoint row
  const x1 = sx + 28, x2 = ex - 28, k = 36;             // ease in / out within the column gutters
  return `M${sx},${sy} C${sx + k},${sy} ${x1 - k},${ry} ${x1},${ry} L${x2},${ry} C${x2 + k},${ry} ${ex - k},${ey} ${ex},${ey}`;
}

// Card + grid geometry (px). Cards are absolutely positioned so the connector
// SVG underneath can use exact coordinates; the column/row pitch leaves a gutter
// for the connectors between cards.
export const FLOW = { cardW: 176, cardH: 104, colPitch: 224, rowPitch: 148 };
// Height of a waypoint-only row — one that carries a routed (skip) edge but no
// card. Kept short so a branch routed onto its own row reads clearly without
// wasting a full card-height of vertical space.
export const ROUTE_ROW = 40;
// Denser geometry for the branched (split) view: many executions stack
// vertically, so rows are tight and the container scrolls.
export const SPLIT_FLOW = { cardW: 184, cardH: 72, colPitch: 212, rowPitch: 86 };

// ---------------------------------------------------------------------------
// Branch split — turn the firings of a "split" model event into one full branch
// per execution. Each firing of the split event is a branch root; downstream
// firings thread onto it by FK ancestry (a payload field pointing back to a
// parent aggregate) or by sharing an aggregateId (same entity, a later step).
// The result is an instance forest: roots = executions, depth follows the real
// parent→child fan-out (Org → its Projects → their Workflows). See twin/
// correlate.ts for the server-side cousin of this FK heuristic.
// ---------------------------------------------------------------------------

// Parse a log entry's JSON payload defensively (returns {} on bad/empty data).
export function parsePayload(s) {
  try { const o = JSON.parse(s ?? "null"); return o && typeof o === "object" ? o : {}; }
  catch { return {}; }
}

// Per-firing records for the loaded case, oldest→newest, each tagged with its
// model column (from the flow layout) and its cross-aggregate FK parent id (the
// payload field — other than its own id — whose value is another firing's
// aggregateId; *Id-suffixed fields win, mirroring the simulator's FK-by-name).
export function caseFirings(layout) {
  const log = (state.log || []).slice().reverse(); // chronological
  const firings = log.map((e, i) => ({
    i,
    ref: e.eventRef,
    aggId: e.aggregateId || "",
    payload: parsePayload(e.payload),
    businessAt: e.businessAt,
    col: layout.place.get(e.eventRef)?.col ?? 0,
  }));
  const aggIds = new Set(firings.map((f) => f.aggId).filter(Boolean));
  for (const f of firings) {
    // ALL payload fields (other than own id) whose value is another firing's
    // aggregateId — the candidate FK parents. *Id-suffixed fields are listed
    // first, but which one actually becomes the parent is decided later by
    // column proximity in buildBranchForest. Collecting every candidate (not
    // just the first match) is what lets a firing carrying several FKs — e.g.
    // Team Member Added with both userId and projectId — latch onto the nearest
    // in-branch ancestor instead of whichever field happens to come first.
    const seen = new Set();
    f.parentAggs = [];
    const keys = Object.keys(f.payload)
      .filter((k) => k !== "id")
      .sort((a, b) => (b.endsWith("Id") ? 1 : 0) - (a.endsWith("Id") ? 1 : 0));
    for (const k of keys) {
      const v = f.payload[k];
      if (typeof v === "string" && v && v !== f.aggId && aggIds.has(v) && !seen.has(v)) {
        seen.add(v);
        f.parentAggs.push(v);
      }
    }
  }
  return firings;
}

// Forest of instance nodes rooted at the firings of `splitRef`. A firing in the
// split subtree (col ≥ the split column) attaches to: its own earlier firing on
// the same aggregate (same entity, prior step) if any; else the firing that owns
// its FK parent. Anything that resolves outside the subtree becomes a root.
export function buildBranchForest(splitRef, layout, firings) {
  const splitCol = layout.place.get(splitRef)?.col ?? 0;
  const sub = firings.filter((f) => f.col >= splitCol);

  // Earliest firing per aggregate (for FK parent resolution) and same-aggregate
  // ordering (for the "later step on the same entity" chain).
  const firstByAgg = new Map();
  for (const f of firings) if (f.aggId && !firstByAgg.has(f.aggId)) firstByAgg.set(f.aggId, f);
  const byAgg = new Map();
  for (const f of sub) { if (!byAgg.has(f.aggId)) byAgg.set(f.aggId, []); byAgg.get(f.aggId).push(f); }
  for (const arr of byAgg.values()) arr.sort((a, b) => a.col - b.col || a.i - b.i);

  const nodeOf = new Map(sub.map((f) => [f, { f, children: [] }]));
  const roots = [];
  for (const f of sub) {
    const node = nodeOf.get(f);
    let parent = null;
    const chain = byAgg.get(f.aggId);
    const pos = chain.indexOf(f);
    if (pos > 0) parent = chain[pos - 1];                       // same entity, earlier step
    else {                                                      // cross-aggregate FK
      // Pick the closest ancestor inside the branch subtree: among every FK the
      // payload resolves to, keep the one with the highest column that is still
      // an earlier step (≥ split, < this firing's column). Preferring the
      // nearest in-branch parent stops a firing that also references an upstream
      // aggregate (e.g. Team Member Added → userId → User Registered, which sits
      // on the shared spine) from failing the subtree test and dropping to a
      // spurious root wired straight from the feeder event.
      for (const agg of f.parentAggs) {
        const p = firstByAgg.get(agg);
        if (!p || p === f || p.col < splitCol || p.col >= f.col) continue;
        if (!parent || p.col > parent.col) parent = p;
      }
    }
    if (parent && nodeOf.has(parent) && parent !== f) nodeOf.get(parent).children.push(node);
    else roots.push(node);
  }
  return { roots, splitCol };
}

// Assign a row to every node: leaves take successive rows, a parent centres on
// its children. Children are ordered by business time so branches read top-down
// in the order they happened. Returns the total row count.
export function layoutForestRows(roots) {
  const byTime = (a, b) => (a.f.businessAt || 0) - (b.f.businessAt || 0);
  const sortKids = (n) => { n.children.sort(byTime); n.children.forEach(sortKids); };
  roots.sort(byTime);
  roots.forEach(sortKids);
  let r = 0;
  const assign = (n) => {
    if (!n.children.length) { n.row = r++; return; }
    n.children.forEach(assign);
    n.row = (n.children[0].row + n.children[n.children.length - 1].row) / 2;
  };
  roots.forEach(assign);
  return r;
}

export function timeline() {
  const total = state.events.length;
  // Which events actually fired for THIS instance — from the event log, not a
  // contiguous step cursor. Derivation (and any non-linear run) fires a SUBSET of
  // the model's events (e.g. Account Confirmed fires but Account Logged In does
  // not, leaving a gap), so colour each box by whether its own event is in the
  // log — every fired step then reads as done regardless of gaps.
  const firedRefs = firedRefSet();
  const firedCounts = firedCountMap();
  const pct = total ? (firedRefs.size / total) * 100 : 0;
  const biz = businessByStep();
  let prevBizIso = null;

  const layout = computeFlowLayout(state.events);

  // Branch split takes over the whole flow area: the shared spine up to the
  // split event, then one full branch per execution downstream. Only honoured
  // while that event actually fired more than once for this case.
  if (state.splitRef && (firedCounts.get(state.splitRef) || 0) > 1) {
    return splitTimelineView(layout, state.splitRef, firedCounts);
  }

  const { cardW, cardH, colPitch, rowPitch } = FLOW;

  // Per-firing expansion (push-down reflow): a ×N badge the user clicked grows
  // its card downward into one row per firing, and the lanes below it shift down
  // to clear it. The reflow is driven by per-lane heights — a lane is as tall as
  // its tallest card, and each lane's Y is the cumulative height of those above
  // plus the usual gutter. With nothing expanded this is exactly the old uniform
  // rowPitch grid, so linear/collapsed flows are byte-identical.
  const expandedSet = state.expandedFirings || new Set();
  const firingsByRef = firingsByRefMap();
  const laneGap = rowPitch - cardH; // gutter between lanes in the original grid
  const isExpanded = (ref) => expandedSet.has(ref) && (firedCounts.get(ref) || 0) > 1;
  const cardHeightFor = (ref) => isExpanded(ref) ? expandedCardHeight(firedCounts.get(ref)) : cardH;

  // Lanes that hold no card (pure waypoint rows for routed skip edges) are short;
  // card lanes start at cardH and grow for any expanded card.
  const cardLanes = new Set(Array.from(layout.place.values(), (p) => p.lane));
  const laneHeight = Array.from({ length: layout.lanes }, (_, L) => cardLanes.has(L) ? cardH : ROUTE_ROW);
  for (const e of state.events) {
    const pos = layout.place.get(e.ref);
    if (pos) laneHeight[pos.lane] = Math.max(laneHeight[pos.lane], cardHeightFor(e.ref));
  }
  const laneTop = [];
  for (let L = 0, acc = 0; L < layout.lanes; L++) { laneTop[L] = acc; acc += laneHeight[L] + laneGap; }

  const W = (layout.cols - 1) * colPitch + cardW;
  const H = layout.lanes ? laneTop[layout.lanes - 1] + laneHeight[layout.lanes - 1] : cardH;

  // The most-recently-fired step (highest linear index that fired) — the cursor
  // we ring as "latest", replacing the old contiguous currentIndex-1.
  let lastFiredIndex = -1;
  state.events.forEach((e, i) => { if (firedRefs.has(e.ref)) lastFiredIndex = i; });

  // Iterate in declared (linear) order so `data-step`, the fired/current logic,
  // and the business-date gap accumulation all stay tied to the step sequence;
  // each card is then *positioned* by its lane/column placement.
  const cards = state.events.map((e, i) => {
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    const fired = firedRefs.has(e.ref);
    const isCurrent = i === lastFiredIndex;
    const isSelected = i === state.selectedStep;
    const phaseBorder = PHASE_TONE[e.phase] || "border-stone-300";
    // Selection (sky ring) is the active interaction → it wins over the amber
    // "latest fired" ring when a card is both.
    const ringClass = isSelected ? "ring-2 ring-sky-500" : isCurrent ? "ring-2 ring-amber-400" : "";
    // Every fired step is done → green. (No contiguous-frontier exclusion: a
    // derived run's fired set has gaps, and each fired box should read as done.)
    const isPast = fired;
    const open = isExpanded(e.ref);

    const bizIso = biz.get(e.ref);
    const bizLabel = fired ? fmtBizDate(bizIso) : null;
    const gapMin = fired && prevBizIso && bizIso ? minutesBetween(prevBizIso, bizIso) : null;
    if (fired && bizIso) prevBizIso = bizIso;

    // Highlight long gaps (≥10 days) in amber so the supplier-slip moment pops.
    const gapTone = gapMin != null && gapMin >= 10 * 1440 ? "text-amber-700 font-semibold" : "text-stone-500";

    // Each step's source mode = its bounded context's configured mode.
    const provMode = provModeForBC(e.boundedContext);

    // Expanded: one row per firing (chronological), each with its own business
    // date and the gap since the previous firing of THIS event. Collapsed: the
    // original single-date footer.
    let footer = "";
    if (open) {
      let prevIso = null;
      const rows = (firingsByRef.get(e.ref) || []).map((f, k) => {
        const d = fmtBizDate(f.businessAt) ?? "—";
        const g = prevIso && f.businessAt ? minutesBetween(prevIso, f.businessAt) : null;
        if (f.businessAt) prevIso = f.businessAt;
        const gt = g != null && g >= 10 * 1440 ? "text-amber-700 font-semibold" : "text-stone-500";
        return `<div class="flex items-baseline justify-between gap-1 leading-none py-0.5">
            <span class="text-stone-700"><span class="text-stone-400 tabular-nums mr-1">${k + 1}.</span><span class="mono font-medium">${d}</span></span>
            ${g != null && g > 0 ? `<span class="${gt}">${fmtGap(g)}</span>` : ""}
          </div>`;
      }).join("");
      footer = `<div class="mt-1.5 pt-1.5 border-t border-stone-100 flex-1 min-h-0 overflow-y-auto text-[10px]">${rows}</div>
        <button data-split-ref="${e.ref}" title="Give each execution its own full box and branch downstream"
          class="mt-1 shrink-0 w-full text-[9px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded px-1 py-0.5 leading-none">⑂ Split into ${firedCounts.get(e.ref)} branches</button>`;
    } else if (fired) {
      footer = `
          <div class="mt-auto pt-1.5 border-t border-stone-100 flex items-baseline justify-between text-[10px]">
            <span class="text-stone-700 font-medium mono">${bizLabel ?? "—"}</span>
            ${gapMin != null && gapMin > 0 ? `<span class="${gapTone}">${fmtGap(gapMin)}</span>` : ""}
          </div>`;
    }

    return `
      <div data-step="${i}" title="View the data as of this event" class="absolute cursor-pointer rounded-md border ${isPast ? "border-emerald-200" : phaseBorder} ${ringClass} ${isPast ? "bg-emerald-50" : "bg-white"} px-3 py-2 ${fired || isSelected ? "" : "opacity-60"} flex flex-col overflow-hidden"
           style="left:${pos.col * colPitch}px; top:${laneTop[pos.lane]}px; width:${cardW}px; height:${cardHeightFor(e.ref)}px; ${provHatch(provMode)}">
        <div class="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
          <span class="truncate">${i+1}. ${escapeHtml(e.boundedContext)}</span>
          <span class="flex items-center gap-1 shrink-0">
            ${e.derived ? `<span class="text-amber-600 font-semibold">DERIVED</span>` : ""}
            ${provChip(provMode)}
          </span>
        </div>
        <div class="text-[12px] font-medium leading-tight text-stone-800">${escapeHtml(e.name)}</div>
        <div class="text-[10px] text-stone-500 mt-1">${escapeHtml(e.role)}</div>
        ${footer}
      </div>
    `;
  }).join("");

  // Fired-count badges as a separate overlay layer: each bubble overhangs its
  // card's top-right corner, so it must live alongside the cards in the (non-
  // clipping) flow container rather than inside the overflow-hidden card. The
  // badge is the click target that toggles this card's expansion.
  const badges = state.events.map((e, i) => {
    const n = firedCounts.get(e.ref) || 0;
    if (n <= 1) return "";
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    return firedCountBadge(e.ref, n, pos.col * colPitch + cardW, laneTop[pos.lane], isExpanded(e.ref));
  }).join("");

  // Connectors: a smooth S-curve from each predecessor's right edge to the
  // event's left edge. Anchored to each card's header band (top + cardH/2) so an
  // expanded card growing downward doesn't drag its edges off the header line.
  // Edges whose target has fired are drawn dark; pending edges stay faint, so
  // the lit path tracks how far the run has progressed.
  const paths = layout.edges.map(({ from, to }) => {
    const a = layout.place.get(from), b = layout.place.get(to);
    if (!a || !b) return "";
    const fired = firedRefs.has(to); // edge lit when its target event has fired (gap-safe)
    const d = flowEdgePath(a, b, layout.waypoints.get(`${from}->${to}`), laneTop, laneHeight, FLOW);
    return `<path d="${d}" fill="none" stroke="${fired ? "#78716c" : "#e7e5e4"}" stroke-width="2" marker-end="url(#flow-arrow)"/>`;
  }).join("");

  const svg = layout.edges.length ? `
        <svg width="${W}" height="${H}" class="absolute top-0 left-0" style="pointer-events:none;">
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e"/>
            </marker>
          </defs>
          ${paths}
        </svg>` : "";

  return `
    <section class="border-b border-stone-200 bg-stone-50">
      ${timelineLegend()}
      <div id="timeline-scroll" class="px-6 py-3 overflow-x-auto">
        <div style="width:${W}px;">
          <div class="relative" style="width:${W}px; height:${H}px;">
            ${svg}
            ${cards}
            ${badges}
          </div>
          <div class="h-1 bg-stone-200 rounded overflow-hidden mt-3" style="width:${W}px;">
            <div class="h-1 bg-amber-400 transition-all duration-300" style="width:${pct}%"></div>
          </div>
        </div>
      </div>
    </section>
  `;
}

// Provenance legend + "last event" strip shared by the flow and branch views.
export function timelineLegend() {
  const prov = state.meta.provenance;
  return `
      <div class="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
        ${prov ? `
        <span class="font-semibold text-stone-600">${prov.steps.real} of ${prov.steps.total} steps from a real source</span>
        <span class="flex items-center gap-1">${provChip("live")} live</span>
        <span class="flex items-center gap-1">${provChip("recorded")} recorded</span>
        <span class="flex items-center gap-1">${provChip("simulated")} simulated</span>` : ""}
        ${lastEventInline()}
      </div>`;
}

// Branch view: the shared spine up to the split event, then one full branch per
// execution downstream (the FK-threaded instance forest from buildBranchForest).
// Stacks vertically and scrolls — there can be many executions.
export function splitTimelineView(layout, splitRef, firedCounts) {
  const { cardW, cardH, colPitch, rowPitch } = SPLIT_FLOW;
  const eventByRef = new Map(state.events.map((e) => [e.ref, e]));
  const splitEvent = eventByRef.get(splitRef);
  const splitName = splitEvent ? splitEvent.name : splitRef.split("/").pop();

  const firings = caseFirings(layout);
  const { roots, splitCol } = buildBranchForest(splitRef, layout, firings);
  const totalRows = Math.max(1, layoutForestRows(roots));

  // Flatten the forest into positioned boxes + parent→child edges.
  const fnodes = [];
  const fedges = [];
  const walk = (n) => { fnodes.push(n); for (const c of n.children) { fedges.push([n, c]); walk(c); } };
  roots.forEach(walk);

  // Spine = events left of the split column, kept on one shared row pinned to
  // the top of the view (row 0). The right-most spine event feeds every branch
  // root; the fan opens downward beneath it.
  const spineRow = 0;
  const spineEvents = state.events
    .filter((e) => (layout.place.get(e.ref)?.col ?? 0) < splitCol)
    .map((e) => ({ e, col: layout.place.get(e.ref).col }))
    .sort((a, b) => a.col - b.col);
  const feeder = spineEvents[spineEvents.length - 1] || null;

  const maxCol = Math.max(splitCol, ...fnodes.map((n) => n.f.col), ...spineEvents.map((s) => s.col));
  const W = maxCol * colPitch + cardW;
  const H = totalRows * rowPitch;
  const xOf = (col) => col * colPitch;
  const yOf = (row) => row * rowPitch + (rowPitch - cardH) / 2;
  const rEdge = (col) => xOf(col) + cardW;
  const midY = (row) => yOf(row) + cardH / 2;
  const curve = (sx, sy, ex, ey, stroke) => {
    const dx = Math.max(20, (ex - sx) * 0.5);
    return `<path d="M${sx},${sy} C${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}" fill="none" stroke="${stroke}" stroke-width="1.5" marker-end="url(#flow-arrow-split)"/>`;
  };

  // Each execution box: the model event it is, the entity's own name, its date.
  const forestCards = fnodes.map((n) => {
    const f = n.f;
    const ev = eventByRef.get(f.ref);
    const label = f.payload.name || f.payload.title || shortId(f.aggId);
    const date = fmtBizDate(f.businessAt) ?? "—";
    return `<div class="absolute rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 flex flex-col overflow-hidden shadow-sm"
         style="left:${xOf(f.col)}px; top:${yOf(n.row)}px; width:${cardW}px; height:${cardH}px;">
        <div class="text-[9px] text-stone-500 truncate">${ev ? escapeHtml(ev.name) : escapeHtml(f.ref.split("/").pop())}</div>
        <div class="text-[11px] font-semibold leading-tight text-stone-800 truncate" title="${escapeHtml(String(label))}">${escapeHtml(String(label))}</div>
        <div class="mt-auto text-[9px] text-stone-500 mono">${date}</div>
      </div>`;
  }).join("");

  // Spine boxes: shared model steps, with a static ×N where the step fanned.
  const spineCards = spineEvents.map(({ e, col }) => {
    const n = firedCounts.get(e.ref) || 0;
    const cnt = n > 1 ? `<span class="ml-1 text-emerald-700 font-bold">×${n}</span>` : "";
    return `<div class="absolute rounded-md border border-stone-300 bg-white px-2.5 py-1.5 flex flex-col overflow-hidden"
         style="left:${xOf(col)}px; top:${yOf(spineRow)}px; width:${cardW}px; height:${cardH}px;">
        <div class="text-[9px] text-stone-500 truncate">${escapeHtml(e.boundedContext)}</div>
        <div class="text-[11px] font-semibold leading-tight text-stone-800 truncate">${escapeHtml(e.name)}${cnt}</div>
        <div class="mt-auto text-[9px] text-stone-400 truncate">${escapeHtml(e.role || "")}</div>
      </div>`;
  }).join("");

  const fpaths = fedges.map(([p, c]) => curve(rEdge(p.f.col), midY(p.row), xOf(c.f.col), midY(c.row), "#34d399")).join("");
  const spinePaths = spineEvents.slice(1).map((s, k) => {
    const a = spineEvents[k]; // previous
    return curve(rEdge(a.col), midY(spineRow), xOf(s.col), midY(spineRow), "#78716c");
  }).join("");
  const rootPaths = feeder
    ? roots.map((rt) => curve(rEdge(feeder.col), midY(spineRow), xOf(rt.f.col), midY(rt.row), "#34d399")).join("")
    : "";

  const svg = `
        <svg width="${W}" height="${H}" class="absolute top-0 left-0" style="pointer-events:none;">
          <defs>
            <marker id="flow-arrow-split" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e"/>
            </marker>
          </defs>
          ${spinePaths}${rootPaths}${fpaths}
        </svg>`;

  const header = `
      <div class="px-6 py-2 flex items-center gap-3 text-[11px] bg-emerald-50 border-b border-emerald-200">
        <span class="font-semibold text-emerald-800">⑂ Branched by "${escapeHtml(splitName)}" — ${roots.length} execution${roots.length === 1 ? "" : "s"}</span>
        <span class="text-stone-500">${fnodes.length} box${fnodes.length === 1 ? "" : "es"} · ${totalRows} branch row${totalRows === 1 ? "" : "s"}</span>
        <button id="btn-merge-branches" class="ml-auto text-[11px] font-medium px-2.5 py-1 rounded-md border border-emerald-300 bg-white hover:bg-emerald-100 text-emerald-800">↩ Merge branches</button>
      </div>`;

  return `
    <section class="border-b border-stone-200 bg-stone-50">
      ${timelineLegend()}
      ${header}
      <div id="timeline-scroll" class="px-6 py-3 overflow-auto" style="max-height:72vh;">
        <div class="relative" style="width:${W}px; height:${H}px;">
          ${svg}
          ${spineCards}
          ${forestCards}
        </div>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Finder-style segmented view switcher — the three representations of this
// workflow's cases: the merged "Workflow" flow (all cases on one diagram with a
// counter on each event), the "By case" flow (the same flow split into one row
// per case), and the case List. Sits top-right in the header, just left of the
// Assistant button. Plain anchors so hash routing drives it.
// `active` ∈ "flow" | "rows" | "list" | null. null = a case drill-down (no mode
// is current; any segment pops back out). #list / #flow / #rows are explicit;
// bare # is the smart default (loadOverview).
// ---------------------------------------------------------------------------
export function viewSwitcher(active) {
  const seg = (href, label, on, title) =>
    `<a href="${href}" class="px-2.5 py-1 rounded ${on ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"} whitespace-nowrap transition-colors" title="${escapeHtml(title)}">${label}</a>`;
  return `
    <div class="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-stone-300 bg-stone-100 text-sm" role="group" aria-label="View">
      ${seg("#flow", "⑂ Workflow", active === "flow", "All cases merged onto one flow, with a counter on each event")}
      ${seg("#rows", "▦ By case", active === "rows", "The same flow split into one row per case")}
      ${seg("#list", "▤ List", active === "list", "Every case as a list — pick one to follow it end to end")}
    </div>`;
}

// Merged flow (#flow): the whole model DAG with a counter on each event = how
// many times it fired ACROSS ALL CASES (state.flow.counts). Reuses the
// single-case layout, card geometry and edge SVG; it deliberately drops the
// per-case extras (branch split, per-firing rows, business dates/gaps) since
// there is no single timeline here — those merge away into the counts. Cards
// that never fired stay ghosted; fired cards tint by relative volume so the
// hotspots in the flow pop out.
export function mergedTimeline() {
  const counts = state.flow?.counts || {};
  const total = state.events.length;
  const firedRefs = new Set(state.events.filter((e) => (counts[e.ref] || 0) > 0).map((e) => e.ref));
  const firedSteps = firedRefs.size;
  const maxCount = Math.max(1, ...state.events.map((e) => counts[e.ref] || 0));

  const layout = computeFlowLayout(state.events);
  const { cardW, cardH, colPitch, rowPitch } = FLOW;
  // Lanes that carry only a routed (skip) edge get a short row; card lanes keep
  // the full card height. With no routed edges this is exactly the old uniform
  // `L * rowPitch` grid (cardH + laneGap === rowPitch), so flows without skips
  // are unchanged.
  const laneGap = rowPitch - cardH;
  const cardLanes = new Set(Array.from(layout.place.values(), (p) => p.lane));
  const laneHeight = Array.from({ length: layout.lanes }, (_, L) => cardLanes.has(L) ? cardH : ROUTE_ROW);
  const laneTop = [];
  for (let L = 0, acc = 0; L < layout.lanes; L++) { laneTop[L] = acc; acc += laneHeight[L] + laneGap; }
  const W = (layout.cols - 1) * colPitch + cardW;
  const H = layout.lanes ? laneTop[layout.lanes - 1] + laneHeight[layout.lanes - 1] : cardH;

  const cards = state.events.map((e, i) => {
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    const n = counts[e.ref] || 0;
    const fired = n > 0;
    const phaseBorder = PHASE_TONE[e.phase] || "border-stone-300";
    const provMode = provModeForBC(e.boundedContext);
    // Heat: relative volume → emerald background tint (fired cards only). Floor
    // keeps low-volume fired cards visibly "on"; ceiling stays readable.
    const heat = fired ? (0.1 + 0.45 * (n / maxCount)).toFixed(3) : 0;
    const heatStyle = fired ? `background-color:rgba(16,185,129,${heat});` : "";
    return `
      <div class="absolute rounded-md border ${fired ? "border-emerald-300" : phaseBorder} bg-white px-3 py-2 ${fired ? "" : "opacity-60"} flex flex-col overflow-hidden"
           style="left:${pos.col * colPitch}px; top:${laneTop[pos.lane]}px; width:${cardW}px; height:${cardH}px; ${heatStyle} ${provHatch(provMode)}">
        <div class="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
          <span class="truncate">${i + 1}. ${escapeHtml(e.boundedContext)}</span>
          ${provChip(provMode)}
        </div>
        <div class="text-[12px] font-medium leading-tight text-stone-800">${escapeHtml(e.name)}</div>
        <div class="text-[10px] text-stone-500 mt-1">${escapeHtml(e.role)}</div>
      </div>`;
  }).join("");

  // Fired-count badges as a separate overlay layer (the same ×N corner bubble the
  // detail view uses): each overhangs its card's top-right corner = how many times
  // that event triggered across all cases. Sibling of the cards so it can overhang
  // the edge (cards clip their own children).
  const badges = state.events.map((e, i) => {
    const n = counts[e.ref] || 0;
    const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
    return flowCountBadge(n, pos.col * colPitch + cardW, laneTop[pos.lane], `${e.name} triggered ${n}× across all cases`);
  }).join("");

  // Connectors: same S-curve as the single-case flow; an edge is lit (dark) when
  // its target event fired in at least one case, faint otherwise.
  const paths = layout.edges.map(({ from, to }) => {
    const a = layout.place.get(from), b = layout.place.get(to);
    if (!a || !b) return "";
    const lit = firedRefs.has(to);
    const d = flowEdgePath(a, b, layout.waypoints.get(`${from}->${to}`), laneTop, laneHeight, FLOW);
    return `<path d="${d}" fill="none" stroke="${lit ? "#78716c" : "#e7e5e4"}" stroke-width="2" marker-end="url(#flow-arrow)"/>`;
  }).join("");

  const svg = layout.edges.length ? `
        <svg width="${W}" height="${H}" class="absolute top-0 left-0" style="pointer-events:none;">
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e"/>
            </marker>
          </defs>
          ${paths}
        </svg>` : "";

  const cases = state.flow?.totalCases ?? 0;
  const pct = total ? (firedSteps / total) * 100 : 0;
  return `
    <section class="border-b border-stone-200 bg-stone-50">
      <div class="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200 bg-white">
        <span class="font-semibold text-stone-600">${state.flow?.totalFirings ?? 0} firings across ${cases} case${cases === 1 ? "" : "s"}</span>
        <span class="text-stone-300">·</span>
        <span>${firedSteps} of ${total} events triggered</span>
        <span class="ml-auto italic text-stone-400">The ×N badge on an event counts its firings across all cases</span>
      </div>
      <div id="timeline-scroll" class="px-6 py-3 overflow-x-auto">
        <div style="width:${W}px;">
          <div class="relative" style="width:${W}px; height:${H}px;">
            ${svg}
            ${cards}
            ${badges}
          </div>
          <div class="h-1 bg-stone-200 rounded overflow-hidden mt-3" style="width:${W}px;">
            <div class="h-1 bg-emerald-400 transition-all duration-300" style="width:${pct}%"></div>
          </div>
        </div>
      </div>
    </section>`;
}

// Merged-flow page (#flow): the all-cases overview. Same header shape as the
// dashboard so the two read as siblings under Overview; the scope bar lets the
// user hop back to the case list (and from there into a single case).
export function mergedFlowView() {
  const m = state.meta;
  const plural = prettyEntity(m.rootAggregatePlural);
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(m.title)} — merged flow</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">All ${escapeHtml(plural.toLowerCase())} on one flow</div>
        </div>
        ${viewSwitcher("flow")}
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    ${mergedTimeline()}
    <main class="flex-1 overflow-auto p-6">
      <p class="text-sm text-stone-500 max-w-3xl">Every case in this workflow, merged onto the model flow. The ×N badge on an event counts how many times it triggered across all ${escapeHtml(plural.toLowerCase())}; brighter cards are busier steps. Switch to <a href="#rows" class="text-stone-800 underline">By case</a> to split it into one row per case, or <a href="#list" class="text-stone-800 underline">List</a> to follow a single case end to end.</p>
    </main>`;
}

// Per-case flow (#rows): the merged flow split into one row per case. Each row is
// a scoped copy of the Workflow view's 2-D layout — same column/lane placement,
// spine, branches and routed skip edges, card geometry, phase border, provenance
// chip/hatch and emerald heat — lit for one case: a card is "on" (emerald, tinted)
// where that case fired the step, ghosted where it didn't, with the same ×N corner
// badge when a step fired more than once; the connector edges between them light
// only where the case actually flowed. The left gutter names the case; the row
// links into its full detail.
export function rowsTimeline() {
  const rows = state.flowRows?.cases || [];
  const layout = computeFlowLayout(state.events);
  const { cardW, cardH, colPitch, rowPitch } = FLOW;
  const labelW = 210;

  if (!rows.length) {
    return `<section class="border-b border-stone-200 bg-stone-50 px-6 py-10 text-center text-sm text-stone-400">No cases have fired yet — run a case (or switch to <a href="#list" class="underline">List</a> and add one) to see it appear as a row here.</section>`;
  }

  // 2-D geometry, identical for every case row (same model topology): the spine,
  // its branches and the routed skip edges land exactly where the Workflow view
  // puts them — only which cards/edges are lit changes per case. Mirrors
  // mergedTimeline's lane math: card lanes keep full height, a lane carrying only
  // a routed edge is short, and laneTop stacks them with the usual gutter.
  const laneGap = rowPitch - cardH;
  const cardLanes = new Set(Array.from(layout.place.values(), (p) => p.lane));
  const laneHeight = Array.from({ length: layout.lanes }, (_, L) => cardLanes.has(L) ? cardH : ROUTE_ROW);
  const laneTop = [];
  for (let L = 0, acc = 0; L < layout.lanes; L++) { laneTop[L] = acc; acc += laneHeight[L] + laneGap; }
  const gridW = (layout.cols - 1) * colPitch + cardW;
  const rowH = layout.lanes ? laneTop[layout.lanes - 1] + laneHeight[layout.lanes - 1] : cardH;

  // Heat is comparable across rows: tint each fired card by its count relative to
  // the busiest single (case, step) anywhere in view.
  let maxCount = 1;
  for (const c of rows) for (const ref in (c.counts || {})) maxCount = Math.max(maxCount, c.counts[ref]);

  // Each row's gutter shows that case's first (up to 3) mandatory attributes,
  // joined from the case rows by id. Fall back to the first plain columns when the
  // model marks nothing required.
  const caseById = new Map((state.cases || []).map((r) => [String(r.id), r]));
  let attrKeys = state.meta?.rootMandatoryAttributes || [];
  if (!attrKeys.length) attrKeys = genericColumns(state.cases || []);
  attrKeys = attrKeys.slice(0, 3);

  // Edge geometry is the model topology, identical for every row; only which edges
  // are "lit" changes per case. Same lane placement + waypoint routing as the
  // Workflow view, so a spine shortcut runs straight and a skip edge bows onto its
  // routed row exactly as it does there.
  const edgeGeom = layout.edges.map(({ from, to }) => {
    const a = layout.place.get(from), b = layout.place.get(to);
    if (!a || !b) return null;
    const d = flowEdgePath(a, b, layout.waypoints.get(`${from}->${to}`), laneTop, laneHeight, FLOW);
    return { d, to };
  }).filter(Boolean);

  const rowsHtml = rows.map((c) => {
    const counts = c.counts || {};
    const firedRefs = new Set(state.events.filter((e) => (counts[e.ref] || 0) > 0).map((e) => e.ref));

    const cards = state.events.map((e, i) => {
      const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
      const n = counts[e.ref] || 0;
      const fired = n > 0;
      const phaseBorder = PHASE_TONE[e.phase] || "border-stone-300";
      const provMode = provModeForBC(e.boundedContext);
      const heat = fired ? (0.1 + 0.45 * (n / maxCount)).toFixed(3) : 0;
      const heatStyle = fired ? `background-color:rgba(16,185,129,${heat});` : "";
      return `
        <div class="absolute rounded-md border ${fired ? "border-emerald-300" : phaseBorder} bg-white px-3 py-2 ${fired ? "" : "opacity-60"} flex flex-col overflow-hidden"
             style="left:${pos.col * colPitch}px; top:${laneTop[pos.lane]}px; width:${cardW}px; height:${cardH}px; ${heatStyle} ${provHatch(provMode)}">
          <div class="flex items-center justify-between gap-1 text-[10px] text-stone-500 mb-0.5">
            <span class="truncate">${i + 1}. ${escapeHtml(e.boundedContext)}</span>
            ${provChip(provMode)}
          </div>
          <div class="text-[12px] font-medium leading-tight text-stone-800">${escapeHtml(e.name)}</div>
          <div class="text-[10px] text-stone-500 mt-1">${escapeHtml(e.role)}</div>
        </div>`;
    }).join("");

    // Same ×N corner badge as the detail / merged views (hidden when a step fired
    // just once for this case, which is the norm — the green card already says it
    // ran). Sibling layer so it can overhang the card's top-right corner.
    const badges = state.events.map((e, i) => {
      const pos = layout.place.get(e.ref) || { col: i, lane: 0 };
      const n = counts[e.ref] || 0;
      return flowCountBadge(n, pos.col * colPitch + cardW, laneTop[pos.lane], `${e.name} fired ${n}× for this case`);
    }).join("");

    const paths = edgeGeom.map(({ d, to }) =>
      `<path d="${d}" fill="none" stroke="${firedRefs.has(to) ? "#78716c" : "#e7e5e4"}" stroke-width="2" marker-end="url(#rows-arrow)"/>`
    ).join("");
    const svg = edgeGeom.length
      ? `<svg width="${gridW}" height="${rowH}" class="absolute top-0 left-0" style="pointer-events:none;">${paths}</svg>`
      : "";

    const id = String(c.caseId);
    // Mandatory-attribute lines: the first as the row's headline (bold value),
    // the rest as "name: value". Falls back to the short id if a case carries no
    // attribute values at all.
    const caseRow = caseById.get(id) || {};
    const attrLines = attrKeys.map((k, ai) => {
      const val = attrText(caseRow[k]);
      const label = prettyEntity(k);
      return ai === 0
        ? `<div class="text-[10px] font-semibold text-stone-800 truncate" title="${escapeHtml(label)}: ${escapeHtml(val)}">${escapeHtml(val)}</div>`
        : `<div class="text-[10px] text-stone-500 truncate" title="${escapeHtml(label)}: ${escapeHtml(val)}"><span class="text-stone-400">${escapeHtml(label)}:</span> ${escapeHtml(val)}</div>`;
    }).join("");
    const headline = attrLines || `<div class="text-[10px] font-semibold text-stone-800 truncate mono">${escapeHtml(id.slice(0, 12))}…</div>`;
    return `
      <a href="#case/${encodeURIComponent(id)}" class="flex items-stretch border-t border-stone-200 hover:bg-stone-50 group">
        <div class="group/case relative sticky left-0 z-20 bg-white group-hover:bg-stone-50 shrink-0 border-r border-stone-200 px-3 flex flex-col justify-center" style="width:${labelW}px;">
          <span role="button" tabindex="0" data-copy-case="${escapeHtml(id)}" title="Copy this case's ID to the clipboard"
            class="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/case:opacity-100 focus:opacity-100 transition-opacity p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/70 cursor-pointer">${iconCopy}</span>
          <div class="min-w-0 group-hover/case:pr-5 transition-[padding] duration-150">
            ${headline}
            ${c.startAt || c.lastAt ? (() => {
              const start = c.startAt || c.lastAt;
              const active = c.lastAt && c.lastAt !== start;
              // Two labeled lines so neither reads as a contradiction: the start is an
              // absolute business date, the last activity a relative time. The "Active"
              // line only appears when the case moved on after it started.
              const startLine = `<div title="${escapeHtml(`Started ${new Date(start).toLocaleString()}`)}"><span class="text-stone-400">Started</span> <span class="text-stone-600 font-medium">${escapeHtml(timeAgo(start))}</span></div>`;
              const activeLine = active
                ? `<div title="${escapeHtml(`Last activity ${new Date(c.lastAt).toLocaleString()}`)}"><span class="text-stone-400">Active</span> <span class="text-stone-600 font-medium">${escapeHtml(timeAgo(c.lastAt))}</span></div>`
                : "";
              return `<div class="text-[10px] text-stone-400 mt-1 leading-tight space-y-0.5">${startLine}${activeLine}</div>`;
            })() : ""}
          </div>
        </div>
        <div class="relative shrink-0 my-2" style="width:${gridW}px; height:${rowH}px;">
          ${svg}${cards}${badges}
        </div>
      </a>`;
  }).join("");

  const total = state.flowRows?.totalCases ?? rows.length;
  const truncated = total > rows.length;
  const totalW = labelW + gridW;
  return `
    <section class="border-b border-stone-200 bg-white">
      <div class="px-6 py-1.5 flex items-center gap-3 text-[10px] text-stone-500 border-b border-stone-200">
        <span class="font-semibold text-stone-600">${rows.length}${truncated ? ` of ${total}` : ""} case${total === 1 ? "" : "s"}</span>
        <span class="text-stone-300">·</span>
        <span>one row per case, most recently active first</span>
        ${truncated
          ? `<button type="button" data-show-all-cases title="Load every case (may be slow for very large workflows)" class="ml-auto italic text-amber-600 hover:text-amber-700 hover:underline cursor-pointer">Showing the ${rows.length} most recent of ${total} — show all</button>`
          : `<span class="ml-auto italic text-stone-400">Click a row to follow that case end to end</span>`}
      </div>
      <div class="overflow-x-auto">
        <svg width="0" height="0" class="absolute"><defs>
          <marker id="rows-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#a8a29e"/>
          </marker>
        </defs></svg>
        <div style="min-width:${totalW}px;">${rowsHtml}</div>
      </div>
    </section>`;
}

// Per-case flow page (#rows): same header shape as the merged flow so they read
// as siblings; the switcher hops between them and the List.
export function flowRowsView() {
  const m = state.meta;
  const singular = prettyEntity(m.rootAggregate);
  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-6">
        <div class="flex-1">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(m.title)} — by case</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">Each ${escapeHtml(singular.toLowerCase())} as its own row</div>
        </div>
        ${viewSwitcher("rows")}
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    ${rowsTimeline()}
    <main class="flex-1 overflow-auto p-6">
      <p class="text-sm text-stone-500 max-w-3xl">The merged flow split into one row per case — each row shows how far that ${escapeHtml(singular.toLowerCase())} got through the steps and which it triggered. Click a row to follow that case end to end, or switch to <a href="#flow" class="text-stone-800 underline">Workflow</a> for the combined view.</p>
    </main>`;
}

// Per-row "copy case ID" control in the by-case gutter. The control lives inside
// the row's <a>, so the handler must swallow the click (preventDefault) to copy
// without also navigating into the case. Keyboard-activatable (it's a role=button
// span). Re-bound on every render of the view.
export function bindFlowRows() {
  document.querySelector("[data-show-all-cases]")?.addEventListener("click", () => {
    state.flowRowsShowAll = true;
    loadFlowRows();
  });
  document.querySelectorAll("[data-copy-case]").forEach((el) => {
    el.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); copyCaseId(el); });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); copyCaseId(el); }
    });
  });
}

export async function copyCaseId(el) {
  const id = el.getAttribute("data-copy-case");
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    // Fallback for non-secure contexts / browsers without the async clipboard API.
    const ta = document.createElement("textarea");
    ta.value = id; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  }
  // Brief check + "Copied!" feedback, pinned visible, then restored.
  el.innerHTML = iconCheck;
  el.setAttribute("title", "Copied!");
  el.classList.add("text-emerald-600", "opacity-100");
  setTimeout(() => {
    el.innerHTML = iconCopy;
    el.setAttribute("title", "Copy this case's ID to the clipboard");
    el.classList.remove("text-emerald-600", "opacity-100");
  }, 1200);
}

// Compact "Last event" summary, folded onto the right of the timeline legend
// row (was its own full-width band). The full chronological history now lives in
// the assistant sidebar's "Event log" tab.
export function lastEventInline() {
  if (!state.log || state.log.length === 0) {
    return `<span class="ml-auto text-stone-400 italic">No events yet — press <b class="not-italic font-semibold">Step forward</b></span>`;
  }
  const last = state.log[0];
  return `
    <span class="ml-auto flex items-center gap-1.5 min-w-0">
      <span class="uppercase tracking-widest text-stone-400 font-semibold">Last event</span>
      <span class="font-medium text-stone-800 truncate">${escapeHtml(last.eventName)}</span>
      ${provChip(last.provenance)}
      <span class="text-stone-300">·</span>
      <span class="mono text-stone-500">${escapeHtml(last.boundedContext)}</span>
      <span class="text-stone-300">·</span>
      <span class="text-stone-500">${escapeHtml(last.role)}</span>
      <span class="text-stone-300">·</span>
      <span class="text-stone-400">${new Date(last.occurredAt).toLocaleTimeString()}</span>
    </span>`;
}

export function detailView() {
  return genericDetailView();
}

// ---------------------------------------------------------------------------
// Model-generic per-run detail. The run is one root-aggregate instance plus the
// rows each event created; this view shows them as a relationship FOREST (child
// aggregates nested under the aggregate root they belong to, e.g. invoice rows
// under their invoice) and marks what the last event changed.
// ---------------------------------------------------------------------------

// Platform/bookkeeping columns we never surface as business fields.
export const GEN_HIDDEN = new Set(["version", "createdAt", "updatedAt", "_provenance"]);

// --- point-in-time ("as of" a selected event) -------------------------------
// When the user selects a timeline event, the data view is reconstructed as it
// stood the moment that event fired — without any server round-trip or
// destructive replay. Every EventLog entry's payload already captures the
// command's args plus the resulting `status` (see commands/base emitFor), and
// the whole log is already loaded in state.log, so we just fold the payloads of
// the events up to & including the selected step. Fields a command never carried
// (e.g. columns filled from exampleData at create, which are time-invariant)
// keep their value from the live row; command-carried fields that have not been
// set yet by the cutoff read blank ("not yet established at this point").
// Payloads are parsed with the shared parsePayload() helper (returns {} for
// empty/bad data, so an empty payload folds to nothing).

// Map event ref → its declared index in state.events (the same index the
// timeline's data-step encodes), so a log entry can be placed against the cutoff.
export function eventRefIndex() {
  const m = new Map();
  state.events.forEach((e, i) => m.set(e.ref, i));
  return m;
}

// id → { agg, row } over the LIVE instance, for static-field carry-over.
export function liveRowsById(inst) {
  const m = new Map();
  if (inst.root && inst.root.id != null) m.set(String(inst.root.id), { agg: inst.rootAggregate, row: inst.root });
  for (const [agg, rows] of Object.entries(inst.entities || {})) {
    for (const row of rows || []) if (row.id != null) m.set(String(row.id), { agg, row });
  }
  return m;
}

// Reconstruct the whole instance from the event log, folding only the entries
// the predicate accepts (by declared step index). `everCarried` (per-aggregate
// set of fields any command ever carried, full-log) lets us blank a column that
// only a LATER command sets vs. carry a time-invariant column from the live row.
export function reconstructInstance(includeIdx, everCarried, live, refIdx, chrono) {
  const folded = new Map(); // id → { agg, row }
  for (const ev of chrono) {
    if (!ev.aggregateId) continue;            // skip markers (empty aggregateId)
    const idx = refIdx.get(ev.eventRef);
    if (idx == null || !includeIdx(idx)) continue;
    const p = parsePayload(ev.payload);
    if (!p || Object.keys(p).length === 0) continue; // empty/bad payload folds to nothing
    const id = String(ev.aggregateId);
    let cur = folded.get(id);
    if (!cur) folded.set(id, (cur = { agg: ev.aggregateRoot, row: {} }));
    Object.assign(cur.row, p);              // later (chronological) values win
  }
  const entities = {};
  let root = null;
  for (const [id, { agg, row: asOf }] of folded) {
    const liveRow = live.get(id)?.row || {};
    const carried = everCarried.get(id) || new Set();
    const out = { id };
    const cols = new Set([...Object.keys(liveRow), ...Object.keys(asOf)]);
    for (const c of cols) {
      if (c === "id") continue;
      if (c in asOf) out[c] = asOf[c];                 // value as of the cutoff
      else if (carried.has(c)) out[c] = null;          // a command sets it only later → not yet established
      else out[c] = liveRow[c];                        // never command-carried → time-invariant
    }
    if (agg === state.instance.rootAggregate && id === String(state.instance.root?.id ?? "")) root = out;
    else (entities[agg] ??= []).push(out);
  }
  return { instanceId: state.instance.instanceId, rootAggregate: state.instance.rootAggregate, root, entities, events: state.instance.events };
}

// The instance to render: the live one, or — when a step is selected — a
// reconstruction of every aggregate's state as of that step. Also stashes
// state.asOfPrev = the reconstruction of the state JUST BEFORE the selected
// event's firings, so the data view can highlight exactly what that event
// changed (across all its firings) by diffing as-of − before.
export function activeDetailInstance() {
  const inst = state.instance || {};
  if (state.selectedStep == null || !state.instance) { state.asOfPrev = null; return inst; }
  const sel = state.selectedStep;
  const refIdx = eventRefIndex();
  const chrono = (state.log || []).slice().reverse(); // state.log is newest-first

  // Fields any command EVER carried, per aggregate (full log) — lets us tell a
  // time-varying column (blank until its command fires) from a static one.
  const everCarried = new Map();
  for (const ev of chrono) {
    if (!ev.aggregateId) continue;
    const p = parsePayload(ev.payload);
    if (!p) continue;
    const id = String(ev.aggregateId);
    let set = everCarried.get(id);
    if (!set) everCarried.set(id, (set = new Set()));
    for (const k of Object.keys(p)) set.add(k);
  }

  const live = liveRowsById(state.instance);
  // All firings of the selected event share the declared index `sel`, so
  // "≤ sel" includes every firing of it and "< sel" excludes them all — the
  // diff is precisely the net effect of all of the selected event's firings.
  const asOf = reconstructInstance((idx) => idx <= sel, everCarried, live, refIdx, chrono);
  state.asOfPrev = reconstructInstance((idx) => idx < sel, everCarried, live, refIdx, chrono);
  return asOf;
}

// The selected event def (for the as-of banner), or null.
export function selectedEventDef() {
  return state.selectedStep != null ? (state.events[state.selectedStep] || null) : null;
}

// A sub-bar shown under the timeline while a step is selected: it states what
// point in time the data view is pinned to and offers a one-click return to the
// live, latest view.
export function asOfBanner() {
  const e = selectedEventDef();
  if (!e) return "";
  return `
    <div class="px-6 py-2 bg-sky-50 border-b border-sky-200 flex items-center gap-3 text-sm">
      <span class="inline-block w-2 h-2 rounded-full bg-sky-500"></span>
      <span class="text-sky-900">Showing data <span class="font-semibold">as of</span> step ${state.selectedStep + 1} · <span class="font-semibold">${escapeHtml(e.name)}</span> <span class="text-sky-700">— fields it changed are highlighted</span></span>
      <button id="btn-clear-asof" class="ml-auto px-2.5 py-1 text-xs rounded-md border border-sky-300 bg-white hover:bg-sky-100 text-sky-800 font-medium">Show latest →</button>
    </div>`;
}

// Every row in the run, tagged with its aggregate. The root instance is listed
// once under the root aggregate (the entities map may also carry it).
export function genAllRows(inst, m) {
  const out = [];
  const rootId = inst.root?.id;
  if (inst.root) out.push({ agg: m.rootAggregate, row: inst.root });
  for (const [agg, rows] of Object.entries(inst.entities || {})) {
    for (const row of rows || []) {
      if (agg === m.rootAggregate && row.id === rootId) continue; // already added
      out.push({ agg, row });
    }
  }
  return out;
}

// aggregate → bounded context, read off the run's event log (so each card can
// show which system the data came from — "from the different bounded contexts").
export function genBcByAgg(inst) {
  const map = {};
  for (const e of inst.events || []) {
    if (e.aggregateRoot && e.boundedContext && !map[e.aggregateRoot]) map[e.aggregateRoot] = e.boundedContext;
  }
  return map;
}

export function genRowKey(agg, row) { return agg + "#" + (row.id ?? JSON.stringify(row)); }

// Relationship forest for the detail view. Every row here is an AGGREGATE-ROOT
// instance: genAllRows reads inst.root + inst.entities, and inst.entities is
// keyed by each event's aggregateRoot (see genericInstanceDetail). Aggregate
// roots are independent consistency boundaries — they reference one another by
// id (e.g. a ChannelReadiness.campaignId pointing at its Campaign) but are NOT
// composed into each other, so each renders as its own top-level box with the
// FK left visible as a plain attribute. (Owned child entities / value objects
// are not separate rows here at all: they ride embedded inside their root row
// and render as embedded tables — see `collections` in genNode.) Hence no
// cross-row nesting. Kept returning the { parentOf, childrenOf } shape that
// genNode / genericDetailView consume; both maps are simply empty.
export function genRelations(allRows, m, bcByAgg) {
  return { parentOf: new Map(), childrenOf: new Map() };
}

// --- diff against the pre-step instance (what the last event touched) -------
export function genPrevRow(agg, id) {
  // The diff baseline: when a step is selected, the reconstruction of the state
  // JUST BEFORE that event's firings (so we highlight what it changed); otherwise
  // the live pre-step snapshot.
  const p = state.selectedStep != null ? state.asOfPrev : state.prevInstance;
  if (!p || id == null) return undefined;
  if (agg === p.rootAggregate && p.root && p.root.id === id) return p.root;
  return (p.entities?.[agg] || []).find((r) => r.id === id);
}

// Blank-tolerant comparison so a value that was "not yet established" (null) and
// later set reads as a change, while null/undefined/"" never differ among
// themselves. Objects/arrays compare by JSON.
export function asOfBlank(v) { return v === null || v === undefined || v === ""; }
export function asOfNorm(v) { return asOfBlank(v) ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v)); }
// Business fields whose value the selected event established/modified: the set of
// columns that differ between the row (as-of the event) and its before-baseline.
export function asOfChangedFields(row, prev) {
  const changed = new Set();
  const cols = new Set(Object.keys(row));
  if (prev) for (const k of Object.keys(prev)) cols.add(k);
  for (const k of cols) {
    if (k === "id" || GEN_HIDDEN.has(k)) continue;
    if (asOfNorm(row[k]) !== asOfNorm(prev ? prev[k] : undefined)) changed.add(k);
  }
  return changed;
}
// The aggregate instance the most recent event touched, read off the event log.
// This is the baseline on the FIRST view of a run: the create event (e.g. the
// root "Campaign Drafted") fires server-side at run start, so there is no
// client-side pre-step snapshot to diff against — without this, that first step
// would light up nothing even though every field is brand new.
export function genLastTouched() {
  const last = state.log && state.log[0];
  if (!last || !last.aggregateRoot || !last.aggregateId) return null;
  return { agg: last.aggregateRoot, id: String(last.aggregateId) };
}
export function genRowChanged(agg, row) {
  // As-of view: a row "changed" iff the selected event (any firing) established or
  // modified at least one of its business fields.
  if (state.selectedStep != null) return asOfChangedFields(row, genPrevRow(agg, row.id)).size > 0;
  const prev = genPrevRow(agg, row.id);
  if (state.prevInstance) {
    if (!prev) return true; // created by the last event
    return JSON.stringify(prev) !== JSON.stringify(row);
  }
  // No pre-step snapshot yet → fall back to the event log's last-touched
  // aggregate so the create step (and a hard page reload) still highlight.
  const lt = genLastTouched();
  return !!lt && lt.agg === agg && row.id != null && String(row.id) === lt.id;
}
export function genFieldChanged(agg, row, field) {
  // As-of view: only the fields the selected event's firings established/modified.
  if (state.selectedStep != null) return asOfChangedFields(row, genPrevRow(agg, row.id)).has(field);
  const prev = genPrevRow(agg, row.id);
  // Updated row with a known baseline → only the fields that actually differ.
  if (prev) return JSON.stringify(prev[field]) !== JSON.stringify(row[field]);
  // New row (or no baseline): every business field is new, so a row the last
  // event changed lights up all of its fields.
  return genRowChanged(agg, row);
}
// The previous step's value of an embedded-collection field, parsed to rows, so
// genEmbeddedTable can highlight only the rows that are new/changed. Null when
// there's no baseline (new parent row / first view) → all rows count as new.
export function genPrevCollection(agg, row, field) {
  const prev = genPrevRow(agg, row.id);
  return prev ? genParseRows(prev[field]) : null;
}

// An embedded-structure field → the rows to render as a small table under its
// row: an array of objects (cart items, invoice lines), or a single object (a
// value object like targetAudience) as one row. Values may arrive already
// parsed or as a JSON string from the projection's TEXT column. Plain
// strings/scalars (and arrays of scalars) return null → rendered inline.
export function genParseRows(v) {
  let parsed = v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t[0] !== "[" && t[0] !== "{") return null;
    try { parsed = JSON.parse(t); } catch { return null; }
  }
  if (Array.isArray(parsed)) return parsed.length && parsed[0] && typeof parsed[0] === "object" ? parsed : null;
  if (parsed && typeof parsed === "object") return [parsed];
  return null;
}

export function genVal(k, v) {
  if (v == null || v === "") return "—";
  if (k === "status") return pill(String(v), String(v));
  if (typeof v === "object") return `<span class="mono text-[11px] text-stone-500">${escapeHtml(JSON.stringify(v))}</span>`;
  return escapeHtml(String(v));
}

export function genEmbeddedTable(name, rows, changed, prevRows) {
  const cols = Object.keys(rows[0]).filter((c) => !GEN_HIDDEN.has(c)).slice(0, 6);
  // Light up the embedded DATA rows that are new/different vs the previous step
  // (the same yellow flash as a scalar field's value), not just the header. With
  // no baseline (new parent row / first view) every row counts as new. The header
  // only carries a small "updated" tag for context.
  const prevSet = prevRows ? prevRows.map((r) => JSON.stringify(r)) : null;
  const isNew = (r) => changed && (!prevSet || !prevSet.includes(JSON.stringify(r)));
  return `
    <div class="overflow-hidden rounded border ${changed ? "border-amber-300" : "border-stone-200"}">
      <div class="text-[10px] font-semibold uppercase tracking-wide px-2 py-1 border-b text-stone-500 bg-stone-50 border-stone-200">${escapeHtml(name)} <span class="text-stone-400 font-normal">· ${rows.length}</span>${changed ? ` <span class="ml-1 px-1 rounded bg-amber-200 text-amber-900 font-semibold">updated</span>` : ""}</div>
      <table class="w-full text-[11px]">
        <thead><tr>${cols.map((c) => `<th class="text-left font-medium text-stone-400 px-2 py-1">${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="border-t border-stone-100 ${isNew(r) ? "row-changed" : ""}">${cols.map((c) => `<td class="px-2 py-1 align-top text-stone-700">${genVal(c, r[c])}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

// One aggregate instance as a card: its fields, any embedded collections, and —
// nested beneath — the child aggregates whose foreign keys point back at it.
export function genNode(agg, row, ctx, depth, prominent) {
  const rk = genRowKey(agg, row);
  if (ctx.seen.has(rk) || depth > 8) return ""; // cycle / runaway guard
  ctx.seen.add(rk);

  const changed = genRowChanged(agg, row);
  const scalars = [], collections = [];
  for (const [k, v] of Object.entries(row)) {
    if (GEN_HIDDEN.has(k) || k === "id") continue;
    const sub = genParseRows(v);
    if (sub) collections.push([k, sub]); else scalars.push([k, v]);
  }
  const grid = scalars.map(([k, v]) => {
    const fc = genFieldChanged(agg, row, k);
    return `<div><div class="text-[10px] text-stone-500">${escapeHtml(k)}</div><div class="text-[12px] text-stone-800 break-words ${fc ? "field-changed inline-block px-1" : ""}">${genVal(k, v)}</div></div>`;
  }).join("");

  const bc = ctx.bcByAgg[agg];
  const bcChip = bc ? `<span class="text-[10px] px-1.5 py-px rounded bg-stone-100 text-stone-500 border border-stone-200">${escapeHtml(bc)}</span>` : "";
  const idChip = row.id != null ? `<span class="mono text-[11px] text-stone-400">${escapeHtml(shortId(String(row.id)))}</span>` : "";
  const updatedChip = changed ? `<span class="text-[10px] px-1.5 py-px rounded bg-amber-100 text-amber-800 font-semibold uppercase tracking-wide">updated</span>` : "";

  const kids = ctx.childrenOf.get(rk) || [];
  const childHtml = kids.length
    ? `<div class="entity-nest pl-3 ml-1 mt-3 flex flex-col gap-2">${kids.map((e) => genNode(e.agg, e.row, ctx, depth + 1, false)).join("")}</div>`
    : "";

  // Embedded sub-tables (value objects / collection fields like commercialTarget,
  // budget, campaignBrief) flow into an auto-fit grid: as many side by side as
  // fit at >=260px each, wrapping to a single stacked column when there isn't
  // room. "Same row if there's space, else stack" without a fixed column count.
  const collectionsHtml = collections.length
    ? `<div class="mt-2 grid gap-3 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">${collections
        .map(([k, sub]) => genEmbeddedTable(k, sub, genFieldChanged(agg, row, k), genPrevCollection(agg, row, k)))
        .join("")}</div>`
    : "";

  return `
    <div class="rounded-lg border ${changed ? "border-amber-300 ring-1 ring-amber-200" : "border-stone-200"} bg-white ${prominent ? "p-4" : "p-3"}">
      <div class="flex items-center gap-2 mb-2">
        <span class="font-semibold text-stone-800 ${prominent ? "text-sm" : "text-[12px]"}">${escapeHtml(prettyEntity(agg))}</span>
        ${bcChip}${idChip}${updatedChip}
      </div>
      <div class="grid grid-cols-2 ${prominent ? "md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" : "sm:grid-cols-2"} gap-x-4 gap-y-1.5">${grid}</div>
      ${collectionsHtml}
      ${childHtml}
    </div>`;
}

// Model-generic per-run detail: header (reuses the btn-back/next/all/reset ids so
// the existing bindings work), the timeline, and the relationship forest.
export function genericDetailView() {
  const inst = activeDetailInstance();
  const root = inst.root || {};
  const total = state.events.length;
  const m = state.meta;

  const allRows = genAllRows(inst, m);
  const bcByAgg = genBcByAgg(inst);
  const { parentOf, childrenOf } = genRelations(allRows, m, bcByAgg);
  const ctx = { bcByAgg, childrenOf, seen: new Set() };

  // Forest roots = rows with no parent; the run root renders first & prominent,
  // the rest (other DDD aggregates not reachable by an FK from the root) follow.
  const runRootKey = inst.root ? genRowKey(m.rootAggregate, inst.root) : null;
  const otherRoots = allRows.filter((e) => {
    const k = genRowKey(e.agg, e.row);
    return k !== runRootKey && !parentOf.has(k);
  });
  const rootCard = inst.root ? genNode(m.rootAggregate, inst.root, ctx, 0, true) : "";
  const otherCards = otherRoots.map((e) => genNode(e.agg, e.row, ctx, 0, false)).join("");

  return `
    <header class="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
      <div class="px-6 py-4 flex items-center gap-4">
        <button id="btn-back" class="p-1.5 -ml-1 rounded text-stone-500 hover:text-stone-900 hover:bg-stone-100" title="Back to dashboard">←</button>
        <div class="flex-1 min-w-0">
          <div class="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">${escapeHtml(m.title)} · ${root.id ? escapeHtml(String(root.id).slice(0, 16)) + "…" : ""}</div>
          <div class="text-stone-900 text-xl font-semibold leading-tight">${escapeHtml(prettyEntity(m.rootAggregate))} ${root.status ? pill(String(root.status), String(root.status)) : ""}</div>
        </div>
        <div class="text-sm text-stone-500 mr-2 tabular-nums"><span class="font-semibold text-stone-800">${firedRefSet().size}</span> / ${total} fired</div>
        <button id="btn-reset" ${state.busy ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Reset</button>
        <button id="btn-next" ${state.busy || state.currentIndex >= total ? "disabled" : ""} class="px-4 py-2 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 font-medium">Step forward →</button>
        <button id="btn-all" ${state.busy || state.currentIndex >= total ? "disabled" : ""} class="px-3 py-2 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">Run all</button>
        ${viewSwitcher(null)}
        <button id="chat-toggle" class="px-3 py-2 text-sm rounded-md border ${state.chatOpen ? "border-amber-400 bg-amber-50 text-amber-800" : "border-stone-300 bg-white hover:bg-stone-50"}" title="Assistant">💬 Assistant</button>
      </div>
    </header>
    ${timeline()}
    ${asOfBanner()}
    <main class="flex-1 overflow-auto p-6 flex flex-col gap-4">
      ${rootCard}
      ${otherCards ? `<div class="grid gap-4 items-start" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${otherCards}</div>` : ""}
    </main>`;
}


// Move the selected event by the flow's 2D layout (column/lane from
// computeFlowLayout — the same geometry the cards are drawn with), NOT the linear
// sequence index. Left/right follow the current branch, bridging back onto the
// connected (usually main) branch at a sub-branch's ends; up/down cross to the
// parallel card stacked above/below. Returns true if the selection moved.
// dir ∈ "left" | "right" | "up" | "down".
export function navSelect(dir) {
  if (state.selectedStep == null) return false;
  const events = state.events || [];
  const curRef = events[state.selectedStep]?.ref;
  if (!curRef) return false;
  const layout = computeFlowLayout(events);
  const cur = layout.place.get(curRef);
  if (!cur) return false;
  const idxByRef = new Map(events.map((e, i) => [e.ref, i]));
  const cells = [];
  events.forEach((e, idx) => {
    const p = layout.place.get(e.ref);
    if (p && e.ref !== curRef) cells.push({ idx, col: p.col, lane: p.lane });
  });
  let pick = null;
  if (dir === "left" || dir === "right") {
    // 1) Within the branch: nearest card in the SAME lane in that direction.
    const cands = cells.filter((c) => c.lane === cur.lane && (dir === "right" ? c.col > cur.col : c.col < cur.col));
    for (const c of cands) {
      if (!pick || (dir === "right" ? c.col < pick.col : c.col > pick.col)) pick = c;
    }
    // 2) At the branch's start/end (no same-lane card that way): bridge along the
    //    flow edge — the predecessor when going left, a successor when going right —
    //    so leaving a sub-branch continues onto the main branch instead of
    //    dead-ending on its first/last card.
    if (!pick) {
      const linked = dir === "left"
        ? (events[state.selectedStep].predecessors || [])
        : events.filter((e) => (e.predecessors || []).includes(curRef)).map((e) => e.ref);
      for (const ref of linked) {
        const p = layout.place.get(ref);
        if (!p || (dir === "left" ? p.col >= cur.col : p.col <= cur.col)) continue; // must be upstream/downstream
        const cand = { idx: idxByRef.get(ref), col: p.col, lane: p.lane };
        if (!pick || (dir === "left" ? p.col > pick.col : p.col < pick.col)) pick = cand; // nearest by column
      }
    }
  } else {
    // Directly above (up) / below (down): the parallel-branch card at the SAME
    // column, nearest lane. Nothing stacked there → no move (don't jump sideways).
    const cands = cells.filter((c) => c.col === cur.col && (dir === "up" ? c.lane < cur.lane : c.lane > cur.lane));
    for (const c of cands) {
      if (!pick || (dir === "up" ? c.lane > pick.lane : c.lane < pick.lane)) pick = c;
    }
  }
  if (!pick) return false;
  state.selectedStep = pick.idx;
  return true;
}

// Arrow keys move the selected event around the flow (only while one is selected,
// so unselected arrows keep their normal scrolling). Registered once on document
// — bindDetail() runs every render, so guard it.
let _keyNavReady = false;
export function initKeyNav() {
  if (_keyNavReady) return;
  _keyNavReady = true;
  const DIRS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  document.addEventListener("keydown", (ev) => {
    if (state.view !== "detail" || state.selectedStep == null) return;
    const dir = DIRS[ev.key];
    if (!dir) return;
    // Don't hijack arrows while the user is typing in a field.
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return;
    ev.preventDefault(); // selection owns the arrows → no page/timeline scroll
    if (navSelect(dir)) render();
  });
}

export function bindDetail() {
  initKeyNav();
  document.getElementById("btn-back")?.addEventListener("click", () => navigate("#"));
  document.getElementById("btn-next")?.addEventListener("click", doNext);
  document.getElementById("btn-all")?.addEventListener("click", doRunAll);
  document.getElementById("btn-reset")?.addEventListener("click", doReset);
  // ×N fired-count badges: toggle per-firing expansion (push-down reflow). The
  // expanded set persists across Step forward within a run; render() re-lays out.
  document.querySelectorAll("[data-toggle-firings]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ref = el.getAttribute("data-toggle-firings");
      if (state.expandedFirings.has(ref)) state.expandedFirings.delete(ref);
      else state.expandedFirings.add(ref);
      render();
    }));
  // "Split into branches": fan this event's executions into full per-branch
  // boxes. Collapse the row-expansion first so the flow doesn't fight the split.
  document.querySelectorAll("[data-split-ref]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ref = el.getAttribute("data-split-ref");
      state.expandedFirings.delete(ref);
      state.splitRef = ref;
      render();
    }));
  document.getElementById("btn-merge-branches")?.addEventListener("click", () => { state.splitRef = null; render(); });
  // Select a timeline event → pin the data view to its point in time (as-of
  // fold of the event log). Re-clicking the selected card clears it. The split
  // button / fired-count badge stopPropagation, so they never select.
  document.querySelectorAll("#timeline-scroll [data-step]").forEach((el) =>
    el.addEventListener("click", () => {
      const i = Number(el.getAttribute("data-step"));
      if (Number.isNaN(i)) return;
      state.selectedStep = state.selectedStep === i ? null : i;
      render();
    }));
  // Click the empty timeline background (between/around the cards) → deselect,
  // same as "Show latest". Card clicks bubble here too, so ignore any click that
  // landed on a card or its badge/split controls.
  document.getElementById("timeline-scroll")?.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-step], [data-toggle-firings], [data-split-ref]")) return;
    if (state.selectedStep == null) return;
    state.selectedStep = null;
    render();
  });
  document.getElementById("btn-clear-asof")?.addEventListener("click", () => { state.selectedStep = null; render(); });
}

