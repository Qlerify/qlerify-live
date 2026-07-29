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

export type Meta = {
  title: string
  rootAggregate: string
  rootAggregatePlural: string
  boundedContextCount: number
  aggregateCount: number
  eventCount: number
  provenance?: { byContext?: Record<string, { mode?: ProvMode }> }
}

export const DEFAULT_META: Meta = {
  title: "Workflow",
  rootAggregate: "Item",
  rootAggregatePlural: "Items",
  boundedContextCount: 0,
  aggregateCount: 0,
  eventCount: 0,
}
