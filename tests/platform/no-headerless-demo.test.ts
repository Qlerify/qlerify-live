// No header-less demo (2026-06-23): the single-tenant demo default was removed.
// A request with NO credentials no longer silently resolves to the SYSTEM org —
// it is REJECTED, so every request must authenticate (the org → workspace →
// workflow flow starts at sign-in). The SYSTEM org remains as control-plane
// plumbing only (superuser home, non-request fallback, audit anchor); it is never
// reachable as a request principal without explicit credentials. This locks the
// decision so the header-less demo can't quietly come back. See
// [[canonical-flow-no-demo]].

import { describe, expect, it } from "vitest";
import { resolveTenantContext } from "../../src/platform/authn/index.js";
import { UnauthenticatedError } from "../../src/errors.js";

describe("no header-less demo default", () => {
  it("rejects a request with no credentials (no silent system fallback)", async () => {
    await expect(resolveTenantContext({})).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("rejects when only an org selector is present but no identity", async () => {
    // A bare X-Org-Id can never stand in for credentials: org_id is DERIVED from a
    // verified identity, never read from a client header on its own.
    await expect(resolveTenantContext({ "x-org-id": "any-org" })).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
