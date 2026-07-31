const ROLE = "Automation"

export class ApiError extends Error {
  status?: number
  path?: string
}

// Registered by the chat layer: every tenant switch swaps the chat threads, and
// signing out drops them. Kept as hooks so api.ts stays dependency-free.
let onScopeChange: () => void = () => {}
let onSignOut: () => void = () => {}

export const setTenantHandlers = (h: { scopeChange: () => void; signOut: () => void }) => {
  onScopeChange = h.scopeChange
  onSignOut = h.signOut
}

export const AUTH = {
  token: () => localStorage.getItem("ql.token") || "",
  org: () => localStorage.getItem("ql.org") || "",
  workflow: () => localStorage.getItem("ql.workflow") || "",

  setSession: (token: string) => {
    localStorage.setItem("ql.token", token || "")
  },

  // Switching org invalidates the selected workflow.
  setOrg: (orgId: string | null) => {
    if (orgId) {
      localStorage.setItem("ql.org", orgId)
    } else {
      localStorage.removeItem("ql.org")
    }
    localStorage.removeItem("ql.workflow")
    onScopeChange()
  },

  setWorkflow: (id: string | null) => {
    if (id) {
      localStorage.setItem("ql.workflow", id)
    } else {
      localStorage.removeItem("ql.workflow")
    }
    onScopeChange()
  },

  clear: () => {
    localStorage.removeItem("ql.token")
    localStorage.removeItem("ql.org")
    localStorage.removeItem("ql.workflow")
    onSignOut()
  },
}

// Set by App so a 401 can bounce to the login screen without importing the router.
let onUnauthorized: () => void = () => {}

export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn
}

export const api = async <T = any>(path: string, opts: RequestInit = {}): Promise<T> => {
  const headers: Record<string, string> = {
    "x-role": ROLE,
    ...((opts.headers as Record<string, string>) || {}),
  }
  if (opts.body != null) {
    headers["Content-Type"] = "application/json"
  }
  const token = AUTH.token()
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }
  const org = AUTH.org()
  if (org) {
    headers["X-Org-Id"] = org
  }
  const workflow = AUTH.workflow()
  if (workflow) {
    headers["X-Workflow-Id"] = workflow
  }

  const res = await fetch(path, { cache: "no-store", ...opts, headers })
  if (res.status === 401 && !path.startsWith("/v1/auth/")) {
    AUTH.clear()
    onUnauthorized()
    throw new ApiError(`401 ${path}: session expired — please sign in`)
  }
  if (!res.ok) {
    const text = await res.text()
    // Prefer the backend's {message} — it's already a clean sentence.
    let msg = `${res.status} ${path}: ${text}`
    try {
      const j = JSON.parse(text)
      if (j && typeof j.message === "string" && j.message) {
        msg = j.message
      }
    } catch {
      /* not JSON */
    }
    const err = new ApiError(msg)
    err.status = res.status
    err.path = path
    throw err
  }
  return res.json()
}

export const isNoModelErr = (e: unknown): boolean => {
  return !!e && typeof (e as Error).message === "string" && /MODEL_NOT_LOADED/.test((e as Error).message)
}

// A stale X-Org-Id (org deleted, or membership removed) — recoverable by dropping
// the selector and retrying. The message arrives JSON-escaped, so don't match quotes.
const isOrgSelectorErr = (e: unknown): boolean => {
  return (
    !!e &&
    typeof (e as Error).message === "string" &&
    /not a member of organization|organization\b.*?not found/i.test((e as Error).message)
  )
}

export type Me = {
  subject?: string
  organizationId?: string | null
  organizations?: { id: string; name?: string; slug?: string }[]
  workflows?: { id: string; name: string }[]
  workflowId?: string | null
  isPlatformAdmin?: boolean
  mustChangePassword?: boolean
}

export const whoami = async (): Promise<Me | null> => {
  try {
    return await api<Me>("/v1/whoami")
  } catch (e) {
    if (AUTH.org() && isOrgSelectorErr(e)) {
      AUTH.setOrg(null)
      try {
        return await api<Me>("/v1/whoami")
      } catch {
        return null
      }
    }
    return null
  }
}
