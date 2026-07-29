import { useEffect, useState } from "react"

export type Route = {
  view: string
  caseId?: string
  connSel?: string
  expSys?: string
  expEntity?: string
}

export const WORKFLOW_SCOPED_VIEWS = new Set([
  "overview",
  "dashboard",
  "detail",
  "flow",
  "rows",
  "model",
  "bcs",
  "connectors",
])

export const parseHash = (): Route => {
  const h = location.hash || ""

  if (h.startsWith("#login")) {
    return { view: "login" }
  }
  if (h.startsWith("#change-password")) {
    return { view: "change-password" }
  }
  if (h.startsWith("#admin")) {
    return { view: "admin" }
  }
  if (h.startsWith("#org")) {
    return { view: "org" }
  }
  if (h.startsWith("#model")) {
    return { view: "model" }
  }
  if (h.startsWith("#flow")) {
    return { view: "flow" }
  }
  if (h.startsWith("#rows")) {
    return { view: "rows" }
  }
  if (h.startsWith("#list")) {
    return { view: "dashboard" }
  }

  const conn = h.match(/^#connectors(?:\/(.+))?$/)
  if (conn) {
    return { view: "connectors", connSel: conn[1] ? decodeURIComponent(conn[1]) : undefined }
  }

  const bcs = h.match(/^#bcs(?:\/([^/]+)(?:\/(.+))?)?$/)
  if (bcs) {
    return {
      view: "bcs",
      expSys: bcs[1] ? decodeURIComponent(bcs[1]) : undefined,
      expEntity: bcs[2] ? decodeURIComponent(bcs[2]) : undefined,
    }
  }

  const detail = h.match(/^#case\/([\w-]+)/)
  if (detail) {
    return { view: "detail", caseId: detail[1] }
  }

  return { view: "overview" }
}

// The browser stores the bare hash as "", so normalise before comparing —
// otherwise navigating to "#" from "" silently fires no hashchange.
const norm = (h: string) => (h === "#" ? "" : h)

export const navigate = (hash: string) => {
  if (norm(location.hash) === norm(hash)) {
    window.dispatchEvent(new HashChangeEvent("hashchange"))
  } else {
    location.hash = hash
  }
}

export const useRoute = (): Route => {
  const [route, setRoute] = useState<Route>(() => parseHash())

  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])

  return route
}
