import { useEffect, useState } from "react"
import { api } from "../lib/api.ts"
import { useStore } from "../lib/store.ts"
import type { FlowAggregate } from "../lib/types.ts"
import { Loading } from "../components/Loading.tsx"
import { Dashboard } from "./Dashboard.tsx"
import { Flow } from "./Flow/Flow.tsx"

// The "home" (#) is a smart default: the merged flow once this workflow has
// cases, otherwise the list — whose empty state onboards the first case.
export const Overview = () => {
  const [target, setTarget] = useState<"flow" | "dashboard" | null>(null)

  useEffect(() => {
    let live = true
    api<FlowAggregate>("/sim/flow-aggregate")
      .then((flow) => {
        if (!live) {
          return
        }
        useStore.getState().set({ flow })
        setTarget((flow.totalCases ?? 0) > 0 ? "flow" : "dashboard")
      })
      .catch(() => {
        if (live) {
          setTarget("dashboard")
        }
      })
    return () => {
      live = false
    }
  }, [])

  if (!target) {
    return <Loading />
  }
  return target === "flow" ? <Flow /> : <Dashboard />
}
