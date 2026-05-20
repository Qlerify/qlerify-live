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

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly status = 404;
}

export function isHandledError(err: unknown): err is DomainError | AuthError | NotFoundError {
  return err instanceof DomainError || err instanceof AuthError || err instanceof NotFoundError;
}
