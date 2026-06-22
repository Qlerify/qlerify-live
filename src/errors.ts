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

// A bound NON-system org with no active project (e.g. its last project was just
// deleted) tried to touch the project-scoped data plane → 409. This is the
// fail-CLOSED replacement for the old org-id sentinel: an empty org never falls
// open into the system demo's tables. The frontend reads this code to show the
// "create your first project" empty state.
export class NoActiveProjectError extends Error {
  readonly code = "NO_ACTIVE_PROJECT";
  readonly status = 409;
  constructor(message = "no active project — create a project in this organization first") {
    super(message);
  }
}

// A project EXISTS and is active, but has no model bound yet (a freshly created
// project that hasn't been pointed at a Qlerify model). Distinct from
// NoActiveProjectError (no project at all). 409 so the frontend can show the
// "set this project's model" prompt instead of a generic 500.
export class ModelNotLoadedError extends Error {
  readonly code = "MODEL_NOT_LOADED";
  readonly status = 409;
  constructor(message = "this project has no model yet — set one to start") {
    super(message);
  }
}

export function isHandledError(err: unknown): err is DomainError | AuthError | UnauthenticatedError | NotFoundError | NoActiveProjectError | ModelNotLoadedError {
  return err instanceof DomainError || err instanceof AuthError || err instanceof UnauthenticatedError || err instanceof NotFoundError || err instanceof NoActiveProjectError || err instanceof ModelNotLoadedError;
}
