// The single mutable UI state object, shared across every view module.
// ES modules export a live binding to the SAME object, so `import { state }`
// anywhere and mutate `state.x = …` — every module sees it. Do NOT reassign the
// binding wholesale (`state = …`); only mutate its fields. Extracted from app.js.

export const state = {
  // global
  view: "dashboard",     // "dashboard" | "detail" | "flow"
  cases: [],
  events: [],
  // Merged "all cases" flow (#flow): { counts: {ref→firings}, totalFirings, totalCases }
  // from /sim/flow-aggregate. The aggregate counterpart of a single case's log.
  flow: null,
  // Per-case flow (#rows): { cases: [{caseId, counts, firings, startAt, lastAt}], totalCases, cap }
  // startAt = first event's business date (case start); lastAt = most recent (business).
  // from /sim/flow-by-case. The merged flow split into one row per case.
  flowRows: null,
  // When the user clicks "show all" in the By-case banner, lift the server-side
  // 50-row cap on subsequent fetches (incl. the live poll). Sticky for the session.
  flowRowsShowAll: false,
  busy: false,
  dashboardTimer: null,  // #flow/#org/#rows live-poll interval handle (shared: routing + dashboard)
  // model-derived UI labels (filled from /sim/meta); defaults keep the UI sane
  // before the first fetch / if the endpoint is unavailable.
  meta: { title: "Workflow", rootAggregate: "Item", rootAggregatePlural: "Items", boundedContextCount: 0, aggregateCount: 0, eventCount: 0 },
  // detail view
  caseId: null,
  instance: null,   // per-run detail from /sim/instance
  prevInstance: null, // the instance snapshot before the last step (per-run diff)
  asOfPrev: null,   // when a step is selected: reconstruction JUST BEFORE its firings (as-of diff baseline)
  log: [],
  currentIndex: 0,
  // Refs whose ×N fired-count badge is expanded into one row per firing on the
  // timeline (push-down reflow). Persists across Step forward within a run;
  // cleared when a different case is loaded.
  expandedFirings: new Set(),
  // The one model event currently "split into branches": the shared spine runs
  // up to it, then the downstream fans out into one full branch per execution
  // (an FK-threaded instance tree). null = no split. Cleared on case switch.
  splitRef: null,
  // The timeline event the user selected to scrub the data view back in time:
  // the data view is reconstructed AS OF this event (the fold of the event log
  // up to & including it). It is the declared index into state.events (the same
  // index `data-step` encodes). null = no selection → the live, latest view.
  // Cleared on case switch and on any action that advances the live run.
  selectedStep: null,
  // per-BC adapter workbench (Part 2.3)
  bcList: null,       // /api/bc index
  bcData: null,       // /api/bc/:bc overview
  bcVerify: null,
  bcTest: null,
  bcRaw: null,
  bcCode: null,
  bcBusy: false,
  // chat
  chatOpen: false,
  chatMessages: [],      // Anthropic.MessageParam[] — the ACTIVE thread (advisor or connector)
  chatInput: "",
  chatBusy: false,
  chatInfo: null,        // { model, effort, apiKeyConfigured, ... }
  chatError: null,
  detailPanelMode: "chat",   // detail-view sidebar tab: "chat" (advisor) | "log" (event log)
  // The connector builder keeps one thread per (workflow, system, table) so
  // switching tables doesn't bleed history. state.chatMessages above is shared
  // with the dashboard/detail "Process advisor", so we stash the advisor thread
  // while a connector thread is active and restore it on leaving the explorer.
  // Every stash key is prefixed with chatScope() (org + workflow) because a
  // workflow switch is SPA-style — no reload — and two workflows built from the
  // same model share their system/table names.
  connectorChats: {},        // connectorChatKey(system, entity) -> Anthropic.MessageParam[] (working copy)
  connectorChatKey: null,    // active connector key, or null when the advisor thread is active
  inConnectorMode: false,    // true when state.chatMessages holds a connector thread
  advisorChats: {},          // chatScope() -> that org+workflow's stashed advisor thread
  chatScope: null,           // scope the LIVE thread belongs to; syncChatScope() detects switches
  connectorChatsHydrated: new Set(), // keys whose server-persisted thread has been loaded this session
  // registry health — non-null message means the active workflow's model couldn't
  // be built into the event registry; surfaced as a top banner.
  registryError: null,
  // toast message (e.g. after setting a workflow's model)
  modelMsg: null,
  // organisation portfolio dashboard (#org) — the tier above the per-workflow
  // overview, spanning every workflow type in the org.
  org: null,            // /org/portfolio result
  orgBusy: false,
  orgMapOpen: false,    // attribute-mapping dialog open?
  orgMap: null,         // /org/mappings result (dialog data)
  orgMapBusy: false,
  orgMapErr: null,
  // create-workflow modal — the model is mandatory at creation (link or upload/paste)
  newWfUrl: "",
  newWfText: "",
  // model & versions (Model page — #model)
  modelNoContent: false,   // workflow has no model.json yet (content 404)
  modelStatus: null,    // GET /v1/workflow/model/status → { versions, current, total, currentVersion, sourceUrl }
  modelContent: null,   // GET /v1/workflow/model/content → raw current workflow.json
  modelBusy: false,     // a restore/reload is in flight
  // Global blocking loading overlay (dim scrim + spinner card). Ref-counted so
  // nested shows (e.g. a workflow switch whose loader opens its own overlay)
  // don't clear early; `active` is gated behind a short delay so quick ops don't
  // flash a scrim. Emitted by wrap() → survives every innerHTML rebuild.
  overlay: { count: 0, active: false, label: "", timer: null },
};
