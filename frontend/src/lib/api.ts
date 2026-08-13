// The domain role (model lane) stamped on every request's x-role header. NOT a
// security boundary — the PDP is; the server only records it on emitted events
// and matches it against the lane on command routes. Resolved per workflow by
// lib/role.ts (explicit pick → admin mapping → this legacy fallback).
let currentRole = "Automation"

export const setDomainRole = (role: string | null) => {
  currentRole = role || "Automation"
}

export const getDomainRole = () => currentRole

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

const apiHeaders = (extra?: HeadersInit, hasBody = false): Record<string, string> => {
  const headers: Record<string, string> = {
    "x-role": currentRole,
    ...((extra as Record<string, string>) || {}),
  }
  if (hasBody) {
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
  return headers
}

const throwApiError = async (res: Response, path: string): Promise<never> => {
  if (res.status === 401 && !path.startsWith("/v1/auth/")) {
    AUTH.clear()
    onUnauthorized()
    throw new ApiError(`401 ${path}: session expired — please sign in`)
  }
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

export const api = async <T = any>(path: string, opts: RequestInit = {}): Promise<T> => {
  const res = await fetch(path, {
    cache: "no-store",
    ...opts,
    headers: apiHeaders(opts.headers, opts.body != null),
  })
  if (!res.ok) {
    await throwApiError(res, path)
  }
  return res.json()
}

type StreamOpts = {
  body: string
  onEvent?: (name: string, data: any) => void
  signal?: AbortSignal
  stallMs?: number
}

// Streaming POST for long-running requests (the chat agent turn). Parses an SSE
// response, invoking onEvent(name, data) per event; resolves with the "result"
// event's data, throws on an "error" event. Extras over api():
//   - signal: caller-side cancellation (the chat Stop button).
//   - stall detection: the server heartbeats every 15s, so a silent stream means
//     the connection is dead (proxy idle-kill, sleeping laptop) — abort instead
//     of hanging the UI forever. Any received byte re-arms the timer.
//   - a plain application/json response is passed through, so the client keeps
//     working against a non-streaming server build.
export const apiStream = async <T = any>(path: string, { body, onEvent, signal, stallMs = 90_000 }: StreamOpts): Promise<T> => {
  const ctrl = new AbortController()
  const onOuterAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) {
      ctrl.abort()
    } else {
      signal.addEventListener("abort", onOuterAbort, { once: true })
    }
  }
  let stalled = false
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer)
    }
    stallTimer = setTimeout(() => {
      stalled = true
      ctrl.abort()
    }, stallMs)
  }

  try {
    const res = await fetch(path, {
      method: "POST",
      cache: "no-store",
      headers: apiHeaders(undefined, true),
      body,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      await throwApiError(res, path)
    }
    const ct = res.headers.get("content-type") || ""
    // `await` (not a bare `return promise`) so the finally below runs only after
    // the body has downloaded — leaving early would detach the caller's abort
    // listener while the body is still streaming, making Stop a silent no-op.
    if (!ct.includes("text/event-stream")) {
      return await res.json()
    }

    // Arm stall detection only now that the response is KNOWN to be a heartbeat
    // stream. Earlier would break the JSON fallback above: a non-streaming
    // server sends no bytes at all until the turn finishes, which is silence by
    // design, not a dead connection.
    armStall()
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let result: T | undefined
    let gotResult = false

    while (!gotResult) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      armStall() // heartbeats land here too — only true silence trips the timer
      buf += decoder.decode(value, { stream: true })
      let sep = buf.indexOf("\n\n")
      while (sep >= 0) {
        const rawEvent = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let event = "message"
        const dataLines: string[] = []
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim()
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart())
          }
          // ":" comment lines (heartbeats) carry no data
        }
        if (dataLines.length > 0) {
          let data: any
          try {
            data = JSON.parse(dataLines.join("\n"))
          } catch {
            data = undefined
          }
          if (data !== undefined) {
            if (event === "result") {
              result = data
              gotResult = true
            } else if (event === "error") {
              const err = new ApiError(data.message || data.error || `${path} failed`)
              err.path = path
              throw err
            } else {
              onEvent?.(event, data)
            }
          }
        }
        sep = buf.indexOf("\n\n")
      }
    }
    if (!gotResult) {
      throw new ApiError("Connection lost before the assistant finished — please try again.")
    }
    return result as T
  } catch (e) {
    if (stalled) {
      throw new ApiError(
        `The connection went silent for ${Math.round(stallMs / 1000)}s and was closed — check the network and try again.`,
      )
    }
    throw e
  } finally {
    if (stallTimer) {
      clearTimeout(stallTimer)
    }
    if (signal) {
      signal.removeEventListener("abort", onOuterAbort)
    }
  }
}

// GET an attachment and hand it to the browser as a file download. Must go
// through fetch (not a plain <a href>): the bearer token lives in localStorage
// and is only attached by apiHeaders(), so a bare navigation would 401. The
// server names the file via Content-Disposition; fallbackName covers a missing
// or unparsable header.
export const apiDownload = async (path: string, fallbackName: string) => {
  const res = await fetch(path, { cache: "no-store", headers: apiHeaders() })
  if (!res.ok) {
    await throwApiError(res, path)
  }
  const blob = await res.blob()
  const cd = res.headers.get("content-disposition") || ""
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] || fallbackName
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Deferred: revoking synchronously can cancel the still-starting download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  // The model lanes this member plays in the active workflow (admin-managed
  // mapping) — defaults the To do filter and the domain-role picker.
  domainRoles?: string[]
  modellerUrl?: string
}

export const MODELLER_FALLBACK = "https://app.qlerify.com"

export const modellerPlaceholder = (me: Me | null | undefined) =>
  `${me?.modellerUrl || MODELLER_FALLBACK}/workflow/<projectId>/<workflowId>`

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
