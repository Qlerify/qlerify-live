// Organisation-level portfolio dashboard routes (the tier above the per-workflow
// overview). READS are member-scoped (requireTenant — any signed-in org member,
// viewers included). The mapping WRITE is org-admin gated, matching the access
// model: "viewers see the dashboard, admins map & govern".
//
// All org scoping comes from the resolved tenant context (requireTenant()), never
// from client input — so the portfolio can only ever span the caller's own org.

import type { FastifyInstance } from "fastify";
import { requireTenant } from "../platform/tenancy/context.js";
import { ensureAllowed } from "../platform/authz.js";
import { DomainError } from "../errors.js";
import { computePortfolio, mappingConfig, setWorkflowMapping } from "../twin/org-dashboard.js";

function fail(reply: any, err: unknown) {
  const status = typeof (err as any)?.status === "number" ? (err as any).status : ((err as any)?.statusCode ?? 500);
  const code = (err as any)?.code ?? "INTERNAL";
  return reply.code(status).send({ error: code, message: (err as Error).message });
}

export function registerOrgRoutes(app: FastifyInstance) {
  // The whole portfolio: north-star band, per-workflow cards, exception feed,
  // bottlenecks, capability-gating status, and the (gated) timeliness panel.
  app.get("/org/portfolio", async (_req, reply) => {
    try {
      const ctx = requireTenant();
      return await computePortfolio(ctx.organizationId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // The mapping dialog's data: capability definitions + each workflow's candidate
  // fields + its current mapping. Member-readable so a viewer sees what's mapped;
  // only an admin can change it (PUT below).
  app.get("/org/mappings", async (_req, reply) => {
    try {
      const ctx = requireTenant();
      return await mappingConfig(ctx.organizationId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Map (or clear) one capability for one workflow. Admin-gated: changing what the
  // org's dashboards measure is an administer action (§6.4).
  app.put("/org/mappings/:workflowId", async (req, reply) => {
    try {
      const ctx = requireTenant();
      await ensureAllowed(
        "organization.administer",
        { id: ctx.organizationId, organizationId: ctx.organizationId, scopeType: "organization" },
        ctx,
      );
      const workflowId = (req.params as { workflowId: string }).workflowId;
      const body = (req.body ?? {}) as { capabilityKey?: string; field?: string | null };
      if (!body.capabilityKey) throw new DomainError("capabilityKey is required");
      const mappings = await setWorkflowMapping(ctx.organizationId, workflowId, body.capabilityKey, body.field ?? null);
      return { ok: true, mapping: mappings[workflowId] ?? {} };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
