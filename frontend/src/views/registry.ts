import type { ComponentType } from "react"
import { Dashboard } from "./Dashboard.tsx"
import { Overview } from "./Overview.tsx"
import { Flow } from "./Flow/Flow.tsx"
import { Rows } from "./Rows.tsx"
import { Detail } from "./Detail/Detail.tsx"
import { Model } from "./Model/Model.tsx"
import { Org } from "./Org/Org.tsx"

// route.view → the component rendered inside the shell. Adding a ported view is
// one line here; anything missing falls back to NotPorted.
// Session gates (login, change-password, no-org) are not routes — App handles them.
export const VIEWS: Record<string, ComponentType> = {
  dashboard: Dashboard,
  overview: Overview,
  flow: Flow,
  rows: Rows,
  detail: Detail,
  model: Model,
  org: Org,
}
