// To-do / next-actions routes. The deterministic frontier read is membership-
// scoped like the sibling /sim/* reads (the tenant plugin has already bound and
// verified the workflow). The AI layer splits read from write: GET reports the
// stored recommendations + freshness and NEVER calls the LLM (it rides the 5s
// poll); the refresh POST is the only generation path and is PDP-gated.

import type { FastifyInstance } from "fastify";
import { computeNextActions } from "../twin/next-actions.js";
import { getRecommendations, refreshRecommendations } from "../twin/next-actions-ai.js";
import { guardData } from "../platform/authz.js";

export function registerTodoRoutes(app: FastifyInstance) {
  // The frontier of every open case: which steps are unblocked, per case, per
  // role. ?role= and ?caseId= filter; ?limit=0 lifts the cap (the /sim idiom);
  // ?staleDays= tunes the amber "stale" threshold (default 3).
  app.get("/sim/next-actions", async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const limitRaw = q.limit === undefined ? undefined : Number(q.limit);
    const staleRaw = q.staleDays === undefined ? undefined : Number(q.staleDays);
    return computeNextActions({
      role: q.role || undefined,
      caseId: q.caseId || undefined,
      ...(limitRaw !== undefined && Number.isFinite(limitRaw) ? { limit: limitRaw > 0 ? limitRaw : null } : {}),
      ...(staleRaw !== undefined && Number.isFinite(staleRaw) && staleRaw > 0 ? { staleDays: staleRaw } : {}),
    });
  });

  // Stored AI recommendations + freshness. Stale/none never auto-regenerates —
  // the deterministic frontier is always available, so a missing AI layer
  // degrades gracefully instead of burning tokens on every poll tick.
  app.get("/sim/recommendations", async () => getRecommendations());

  // The one LLM path: rank + phrase the current candidate set, store the blob.
  // `edit`-gated (spends the org's LLM tokens and writes shared state).
  app.post("/sim/recommendations/refresh", async (req) => {
    await guardData("recommendations.generate");
    return refreshRecommendations(req.log);
  });
}
