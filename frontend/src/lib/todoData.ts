import { api } from "./api.ts"
import { useStore } from "./store.ts"
import type { RecommendationsView } from "./types.ts"

// The AI layer is strictly optional: every load failure leaves the store as-is
// and the deterministic frontier keeps the tab fully functional.
export const loadRecs = async () => {
  try {
    const recs = await api<RecommendationsView>("/sim/recommendations")
    useStore.getState().set({ recs })
  } catch {
    // no key / no permission / transient — the deterministic list stands
  }
}

// The only generation path (POST — spends the org's LLM tokens). Returns an
// error message for the caller to surface, or null on success.
export const refreshRecs = async (): Promise<string | null> => {
  const s = useStore.getState()
  if (s.recsBusy) {
    return null
  }
  s.set({ recsBusy: true })
  try {
    const recs = await api<RecommendationsView>("/sim/recommendations/refresh", { method: "POST", body: "{}" })
    useStore.getState().set({ recs })
    return null
  } catch (e) {
    return (e as Error).message
  } finally {
    useStore.getState().set({ recsBusy: false })
  }
}
