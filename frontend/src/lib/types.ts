export type ProvMode = "simulated" | "recorded" | "live"

export type CaseRow = {
  id: string
  status?: string
  progress: number
  total: number
  lastEvent?: { eventName: string; provenance?: ProvMode } | null
  [key: string]: unknown
}

export type EventDef = {
  ref: string
  name: string
  boundedContext: string
  role: string
  phase?: number
  predecessors?: string[]
}

export type FlowAggregate = {
  counts: Record<string, number>
  totalFirings: number
  totalCases: number
}

export type FlowCaseRow = {
  caseId: string
  counts: Record<string, number>
  firings?: number
  startAt?: string | null
  lastAt?: string | null
}

export type FlowRows = {
  cases: FlowCaseRow[]
  totalCases: number
  cap?: number
}

export type LogEntry = {
  eventRef: string
  eventName: string
  boundedContext: string
  role: string
  occurredAt: string
  businessAt?: string | null
  provenance?: ProvMode
  aggregateId?: string
  payload?: string
}

export type Row = Record<string, unknown>

export type Instance = {
  instanceId: string
  rootAggregate?: string
  root?: Row | null
  entities?: Record<string, Row[]>
  events?: LogEntry[]
}

export type Meta = {
  title: string
  rootAggregate: string
  rootAggregatePlural: string
  boundedContextCount: number
  aggregateCount: number
  eventCount: number
  rootMandatoryAttributes?: string[]
  provenance?: {
    steps?: { real: number; total: number }
    byContext?: Record<string, { mode?: ProvMode }>
  }
}

export const DEFAULT_META: Meta = {
  title: "Workflow",
  rootAggregate: "Item",
  rootAggregatePlural: "Items",
  boundedContextCount: 0,
  aggregateCount: 0,
  eventCount: 0,
}

export type ModelVersion = {
  id: string
  source: string
  savedAt: string
  summary?: { events?: number }
  sourceUrl?: string | null
  sourceName?: string | null
}

export type ModelStatus = {
  versions: ModelVersion[]
  current: number
  total: number
  currentVersion: ModelVersion | null
  sourceUrl: string | null
}

export type RebuildInfo = {
  connectors?: number
  inserted?: number
  derived?: { events?: number }
  failures?: unknown[]
}

export type TwinTrust = { pct: number; real: number; total: number }

export type OrgWorkflowCard = {
  id: string
  name: string
  hasModel: boolean
  active: number
  completed: number
  throughputRecent: number
  totalSteps: number
  twinTrust: TwinTrust
  topRoleQueue?: { role: string; count: number } | null
  oldestActive?: { stepName: string; ageDays: number } | null
  cycleIndex?: number | null
  expectedDays?: number | null
  atRisk?: number
  reworkCount?: number
  softFailCount?: number
}

export type OrgException = {
  kind: string
  title: string
  detail: string
  workflowId: string
  workflowName: string
  caseId: string
  ageDays: number
}

export type OrgBottleneck = {
  workflowId: string
  workflowName: string
  stepName: string
  boundedContext: string
  role: string
  waiting: number
}

export type OrgPortfolio = {
  error?: string
  generatedAt: string
  northStar: {
    workflowCount: number
    activeInstances: number
    totalInstances: number
    completedInstances: number
    modelledCount: number
    atRisk: number
    cycleIndex?: number | null
    completedRecent: number
    throughputSeries: { week: string; count: number }[]
    flowRatio?: number | null
    twinTrust: TwinTrust
    conformance: { pct: number; clean: number; total: number }
  }
  workflows: OrgWorkflowCard[]
  exceptions: OrgException[]
  bottlenecks: OrgBottleneck[]
  capabilities?: { key: string; state: string; description: string }[]
  timeliness?: {
    overdue: number
    predictedLate?: number
    onTime: number
    scorable: number
    rows?: { kind: string; workflowId: string; workflowName: string; caseId: string; dueDate: string; predictedFinish?: string; days: number }[]
    partial?: { unmapped: string[] } | null
  }
  valueAtRisk?: {
    totalDays: number
    overdueDays: number
    slipDays: number
    overrunDays: number
    hasCommitData: boolean
    byWorkflow?: { workflowId: string; workflowName: string; totalDays: number; overdueDays: number; slipDays: number; overrunDays: number }[]
  } | null
  aiActivity?: {
    live: boolean
    note?: string
    aiActionShare: { pct?: number | null; ai: number; human: number }
    override: { pct?: number | null; overridden: number; aiEvents: number }
    guardrail: { pct?: number | null; aiBlocked: number; aiAttempts: number }
  } | null
  connectorFreshness?: {
    preview?: boolean
    note?: string
    sources?: { name: string; status: string; lastEventAgo: string; slaMinutes: number }[]
  } | null
}

export type OrgMapping = {
  error?: string
  capabilities?: { key: string; label: string; description: string; unlocks: string }[]
  workflows?: {
    id: string
    name: string
    hasModel: boolean
    mapping?: Record<string, string>
    suggested?: string
    fields?: { name: string; dataType?: string; dateish?: boolean }[]
  }[]
}
