// C1 regression (2026-07-07 security review): the credential-set route must NEVER
// let a client choose the process.env slot it writes. The KEY is derived purely
// server-side from the adapter's own stamped tenant context. These tests pin the
// security-relevant properties of that derivation:
//   1. it is a pure function of the adapter config (no client input reaches it),
//   2. it is namespaced per (org, workflow, adapter) so tenants never collide,
//   3. no id — however maliciously crafted — can escape the CRED_ namespace to
//      target a well-known var (NODE_ENV, HTTPS_PROXY, PATH, …), and
//   4. it is stable, so the resolver reads back the same key that was written.

import { describe, it, expect } from "vitest";
import { credentialEnvKey } from "../../src/http/adapter-routes.js";
import type { AdapterConfig } from "../../src/packs/types.js";

const base = (over: Partial<AdapterConfig> = {}): AdapterConfig => ({
  id: "adp-1", kind: "authored", boundedContext: "BC", targetEntity: "Order",
  phase: "built", mode: "recorded", organizationId: "org-1", workflowId: "wf-1", ...over,
});

describe("credentialEnvKey — C1 arbitrary process.env write", () => {
  it("is derived only from the adapter config (never from client input)", () => {
    // The signature takes no request body — the key is a pure function of cfg.
    expect(credentialEnvKey(base())).toBe("CRED_org_1_wf_1_adp_1");
    expect(credentialEnvKey(base())).toBe(credentialEnvKey(base())); // deterministic
  });

  it("always stays inside the CRED_ namespace and env-name charset", () => {
    for (const cfg of [
      base(),
      base({ id: "../../etc", organizationId: "a b", workflowId: "x=y" }),
      base({ id: "", organizationId: "", workflowId: "" }),
      base({ organizationId: null, workflowId: null }),
    ]) {
      const key = credentialEnvKey(cfg);
      expect(key).toMatch(/^CRED_[A-Za-z0-9_]+$/); // no shell/env metachars survive
    }
  });

  it("cannot be steered onto a well-known variable (NODE_ENV, HTTPS_PROXY, PATH)", () => {
    // Even ids crafted to look like an assignment to a sensitive var stay prefixed.
    const attacks = ["NODE_ENV", "HTTPS_PROXY", "PATH", "NODE_TLS_REJECT_UNAUTHORIZED"];
    for (const evil of attacks) {
      const key = credentialEnvKey(base({ id: evil, organizationId: evil, workflowId: evil }));
      expect(key.startsWith("CRED_")).toBe(true);
      expect(["NODE_ENV", "HTTPS_PROXY", "PATH", "NODE_TLS_REJECT_UNAUTHORIZED"]).not.toContain(key);
    }
  });

  it("namespaces per tenant so two tenants never collide on one slot", () => {
    const a = credentialEnvKey(base({ organizationId: "orgA", workflowId: "wf", id: "same" }));
    const b = credentialEnvKey(base({ organizationId: "orgB", workflowId: "wf", id: "same" }));
    expect(a).not.toBe(b);
    // Different workflow within the same org also gets its own slot.
    const c = credentialEnvKey(base({ organizationId: "orgA", workflowId: "wf2", id: "same" }));
    expect(c).not.toBe(a);
  });

  it("still produces a valid namespaced key for legacy unstamped adapters", () => {
    const key = credentialEnvKey(base({ organizationId: null, workflowId: null, id: "legacy" }));
    expect(key).toBe("CRED_none_none_legacy");
    expect(key).toMatch(/^CRED_[A-Za-z0-9_]+$/);
  });
});
