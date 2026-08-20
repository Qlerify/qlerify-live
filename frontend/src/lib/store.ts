import { create } from "zustand"
import type { Me } from "./api.ts"
import { createOv } from "./ovState.ts"
import type { OvState } from "./ovState.ts"
import type {
  CaseRow,
  ChatInfo,
  ChatMessage,
  ConnectorsData,
  EventDef,
  ExpState,
  FlowAggregate,
  FlowRows,
  Instance,
  LogEntry,
  Meta,
  ModelStatus,
  NextAction,
  NextActionsResult,
  RecommendationsView,
  TestResult,
  VerifyResult
} from "./types.ts"
import { DEFAULT_META, EMPTY_EXP } from "./types.ts"

type Toast = { ok: boolean; text: string } | null

export type ChatProgress = { startedAt: number; tool: string | null; iteration: number; toolsDone: number }

type State = {
  me: Me | null
  orgs: NonNullable<Me["organizations"]>
  booting: boolean

  cases: CaseRow[]
  events: EventDef[]
  meta: Meta
  flow: FlowAggregate | null
  flowRows: FlowRows | null
  // The workflow-wide frontier (all cases) — the To do tab / Flow panel / List
  // columns read this; refreshed by the same stamp-gated Overview poll.
  nextActions: NextActionsResult | null
  // The open case's own frontier — the Detail "Next" banner + ready rings.
  caseNextActions: NextAction[] | null
  // Stored AI ranking of the frontier + its freshness; never auto-generated.
  recs: RecommendationsView | null
  recsBusy: boolean

  instance: Instance | null
  prevInstance: Instance | null
  log: LogEntry[]
  currentIndex: number
  expandedFirings: Set<string>
  splitRef: string | null
  selectedStep: number | null
  busy: boolean
  registryError: string | null

  orgMenuOpen: boolean
  wfMenuOpen: boolean
  acctMenuOpen: boolean
  orgMemberCount: number | null
  orgMemberCountFor: string | null

  newOrgOpen: boolean
  newOrgBusy: boolean
  newOrgErr: string | null
  newWfOpen: boolean
  newWfBusy: boolean
  newWfErr: string | null

  toast: Toast
  overlay: { count: number; label: string }

  modelStatus: ModelStatus | null
  modelContent: string | null
  modelNoContent: boolean
  modelBusy: boolean
  projModelOpen: boolean
  projModelBusy: boolean
  projModelErr: string | null

  exp: ExpState
  ov: OvState

  connectors: ConnectorsData | null
  connSel: string | null
  connTab: string
  connBusy: boolean
  connError: string | null
  connVerify: VerifyResult | null
  connTest: TestResult | null

  chatOpen: boolean
  chatInfo: ChatInfo | null
  chatMessages: ChatMessage[]
  chatInput: string
  chatBusy: boolean
  chatError: string | null
  // One-click replies the assistant proposed for its last question. Ephemeral —
  // cleared on send, clear, and every thread swap; never persisted.
  chatSuggestions: string[]
  // Live progress of the in-flight turn, fed by the /chat SSE stream. null when idle.
  chatProgress: ChatProgress | null
  detailPanelMode: string
  expPanelMode: string

  set: (patch: Partial<State>) => void
  closeMenus: () => void
  showToast: (t: Toast) => void
}

export const useStore = create<State>((set) => ({
  me: null,
  orgs: [],
  booting: true,

  cases: [],
  events: [],
  meta: DEFAULT_META,
  flow: null,
  flowRows: null,
  nextActions: null,
  caseNextActions: null,
  recs: null,
  recsBusy: false,

  instance: null,
  prevInstance: null,
  log: [],
  currentIndex: 0,
  expandedFirings: new Set(),
  splitRef: null,
  selectedStep: null,
  busy: false,
  registryError: null,

  orgMenuOpen: false,
  wfMenuOpen: false,
  acctMenuOpen: false,
  orgMemberCount: null,
  orgMemberCountFor: null,

  newOrgOpen: false,
  newOrgBusy: false,
  newOrgErr: null,
  newWfOpen: false,
  newWfBusy: false,
  newWfErr: null,

  toast: null,
  overlay: { count: 0, label: "" },

  modelStatus: null,
  modelContent: null,
  modelNoContent: false,
  modelBusy: false,
  projModelOpen: false,
  projModelBusy: false,
  projModelErr: null,

  exp: EMPTY_EXP,
  ov: createOv(),

  connectors: null,
  connSel: null,
  connTab: "details",
  connBusy: false,
  connError: null,
  connVerify: null,
  connTest: null,

  chatOpen: false,
  chatInfo: null,
  chatMessages: [],
  chatInput: "",
  chatBusy: false,
  chatError: null,
  chatSuggestions: [],
  chatProgress: null,
  detailPanelMode: "chat",
  expPanelMode: "chat",

  set: (patch) => set(patch),

  closeMenus: () => set({ orgMenuOpen: false, wfMenuOpen: false, acctMenuOpen: false }),

  showToast: (toast) => {
    set({ toast })
    if (toast) {
      setTimeout(() => set({ toast: null }), 3000)
    }
  },
}))

export const currentOrgName = (me: Me | null, orgs: State["orgs"]) => {
  const id = me?.organizationId
  const o = (orgs || []).find((x) => x.id === id)
  if (o) {
    return o.name || o.slug || "—"
  }
  return id ? id.slice(0, 8) : "—"
}
