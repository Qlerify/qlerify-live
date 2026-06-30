// Deployment feature flags (a neutral leaf module — safe to import from any layer).
//
// The connector / AI-codegen subsystem runs untrusted, AI-influenced code in a
// sandbox. A locked-down deployment (e.g. an on-prem install at the highest
// security bar) can switch the whole subsystem OFF — every connector/adapter
// mutation, AI codegen, and ingest — by setting QLERIFY_CONNECTORS_ENABLED to
// "false" / "0" / "off". Default ON. Enforced centrally in guardData() for
// connector.* actions and at the runConnector() execution chokepoint.
// (Per-org granularity is a later refinement; today this is deployment-wide.)
export function connectorsEnabled(): boolean {
  const v = (process.env.QLERIFY_CONNECTORS_ENABLED ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off" && v !== "no";
}
