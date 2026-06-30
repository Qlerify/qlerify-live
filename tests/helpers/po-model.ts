// Shared test fixture: a minimal PurchaseOrder model bound the same way the
// runtime binds one — per workflow, in memory (setWorkflowModel), NOT via a
// global .qlerify/workflow.json (that legacy file is gone). Tests that exercise
// adapter/ingest code paths call getOntology() internally, so they must run
// inside a workflow tenant context with the model bound. modelHarness() wraps
// both: setWorkflowModel for the content + runWithTenant for the ALS scope.

import { setWorkflowModel } from "../../src/ontology/model.js";
import { runWithTenant } from "../../src/platform/tenancy/context.js";
import { newId } from "../../src/platform/ids.js";
import type { TenantContext } from "../../src/platform/types.js";

/** A minimal SAP PurchaseOrder model in Qlerify's native export shape. The
 * entity's required fields + types are what synthesizeRow / ingest exercise. */
export const PURCHASE_ORDER_MODEL = JSON.stringify({
  version: 1,
  boundedContext: "SAP",
  roles: ["Buyer"],
  domainEvents: {
    PurchaseOrderCreated: {
      event: "Purchase Order Created",
      role: "Buyer",
      command: { $ref: "#/schemas/commands/CreatePurchaseOrder" },
      aggregateRoot: { $ref: "#/schemas/entities/PurchaseOrder" },
      acceptanceCriteria: ["Given a supplier, When a buyer submits, Then a DRAFT purchase order is created"],
    },
  },
  schemas: {
    entities: {
      PurchaseOrder: {
        required: ["id", "projectId", "partNumber", "qty", "supplierId", "status"],
        fields: [
          { name: "id", dataType: "string" },
          { name: "projectId", dataType: "string" },
          { name: "partNumber", dataType: "string" },
          { name: "qty", dataType: "integer" },
          { name: "supplierId", dataType: "string" },
          { name: "status", dataType: "string", exampleData: ["DRAFT", "DRAFT", "DRAFT"] },
        ],
      },
    },
    commands: {
      CreatePurchaseOrder: { required: ["supplierId"], fields: [{ name: "supplierId" }, { name: "partNumber" }] },
    },
  },
});

export interface ModelHarness {
  workflowId: string;
  orgId: string;
  ctx: TenantContext;
  /** Run `fn` with the workflow model bound and the tenant context active. */
  run<T>(fn: () => T): T;
}

/** Bind a fixture model to a fresh workflow and return a harness that runs code
 * inside that workflow's tenant context. A unique workflowId per harness means a
 * unique gen__p<hex>_ projection namespace, so test files don't cross-contaminate
 * each other's ingested rows. */
export function modelHarness(model: string = PURCHASE_ORDER_MODEL): ModelHarness {
  const orgId = newId();
  const workflowId = newId();
  const identityId = newId();
  const ctx: TenantContext = {
    organizationId: orgId,
    principal: { id: identityId, type: "identity" },
    identityId,
    subject: `po-fixture-${workflowId}`,
    workflowId,
  };
  setWorkflowModel(workflowId, model, null, `po-fixture-${workflowId}`);
  return {
    workflowId,
    orgId,
    ctx,
    run: (fn) => runWithTenant(ctx, fn),
  };
}
