// Per-workflow resolution of "which lane am I acting as" (the x-role header).
// An explicit pick (the user may play several lanes) beats the admin mapping's
// first lane; with neither, api.ts falls back to the legacy "Automation".
// Persisted per workflow, the SegmentStepMatrix localStorage idiom.
import { AUTH, setDomainRole } from "./api.ts"
import type { Me } from "./api.ts"

const key = () => `ql.role.${AUTH.workflow() || "-"}`

export const storedRolePick = (): string => {
  try {
    return localStorage.getItem(key()) || ""
  } catch {
    return ""
  }
}

export const persistRolePick = (role: string) => {
  try {
    if (role) {
      localStorage.setItem(key(), role)
    } else {
      localStorage.removeItem(key())
    }
  } catch {
    /* private mode etc. */
  }
}

/** Resolve + apply the acting role for the active workflow. Called after every
 * whoami (boot, org/workflow switch) and by the picker on change. Returns the
 * role now in effect ("" = the api.ts fallback). */
export const applyDomainRole = (me: Me | null): string => {
  const role = storedRolePick() || me?.domainRoles?.[0] || ""
  setDomainRole(role || null)
  return role
}
