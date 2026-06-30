// DomainError = an invariant or precondition was violated → 422 to caller.
// AuthError    = role not allowed for this command → 403.
// NotFoundError = aggregate doesn't exist → 404.
// Anything else bubbles up as 500 (real infra failure).

export class DomainError extends Error {
  readonly code = "DOMAIN_ERROR";
  readonly status = 422;
  constructor(message: string, readonly violations?: string[]) {
    super(message);
  }
}

export class AuthError extends Error {
  readonly code = "AUTH_ERROR";
  readonly status = 403;
}

// Credential missing/invalid/expired → 401 (re-authenticate). Distinct from
// AuthError (403 = authenticated but not permitted) so the frontend can redirect
// to the login screen on 401 only.
export class UnauthenticatedError extends Error {
  readonly code = "UNAUTHENTICATED";
  readonly status = 401;
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly status = 404;
}

// A bound NON-system org with no active workflow (e.g. its last workflow was just
// deleted) tried to touch the workflow-scoped data plane → 409. This is the
// fail-CLOSED replacement for the old org-id sentinel: an empty org never falls
// open into the system demo's tables. The frontend reads this code to show the
// "create your first workflow" empty state.
export class NoActiveWorkflowError extends Error {
  readonly code = "NO_ACTIVE_WORKFLOW";
  readonly status = 409;
  constructor(message = "no active workflow — create a workflow in this organization first") {
    super(message);
  }
}

// A workflow EXISTS and is active, but has no model bound yet (a freshly created
// workflow that hasn't been pointed at a Qlerify model). Distinct from
// NoActiveWorkflowError (no workflow at all). 409 so the frontend can show the
// "set this workflow's model" prompt instead of a generic 500.
export class ModelNotLoadedError extends Error {
  readonly code = "MODEL_NOT_LOADED";
  readonly status = 409;
  constructor(message = "this workflow has no model yet — set one to start") {
    super(message);
  }
}

export function isHandledError(err: unknown): err is DomainError | AuthError | UnauthenticatedError | NotFoundError | NoActiveWorkflowError | ModelNotLoadedError | LlmError {
  return err instanceof DomainError || err instanceof AuthError || err instanceof UnauthenticatedError || err instanceof NotFoundError || err instanceof NoActiveWorkflowError || err instanceof ModelNotLoadedError || err instanceof LlmError;
}

// An upstream AI-provider (Anthropic) call failed — invalid/expired API key, rate
// limit, or the provider being unreachable. Carries a clean, user-facing message so
// the raw provider response (status line, request_id, JSON body) is NEVER surfaced
// to the user; the original error is still logged server-side. code/status vary by
// failure mode (see friendlyLlmError in llm/anthropic.ts).
export class LlmError extends Error {
  constructor(message: string, readonly code: string = "LLM_ERROR", readonly status: number = 502) {
    super(message);
  }
}
