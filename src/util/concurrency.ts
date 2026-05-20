// Optimistic-locking helper. Each aggregate carries a `version` integer;
// updates must specify the expected version. If another writer changed it
// concurrently, the conditional update affects 0 rows — we surface that as
// a DomainError so the caller can retry.

import { DomainError } from "../errors.js";

export class ConcurrencyError extends DomainError {
  constructor(aggregate: string, id: string) {
    super(`concurrent update detected on ${aggregate}(${id}); retry`);
  }
}

export function nextVersion(current: number): number {
  return current + 1;
}
