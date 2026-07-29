import type { ComponentType } from "react"
import { Dashboard } from "./Dashboard.tsx"

// route.view → the component rendered inside the shell. Adding a ported view is
// one line here; anything missing falls back to NotPorted.
// Session gates (login, change-password, no-org) are not routes — App handles them.
export const VIEWS: Record<string, ComponentType> = {
  dashboard: Dashboard,
  // Normally the merged flow when the workflow has cases; until that view is
  // ported, overview lands on the list.
  overview: Dashboard,
}
