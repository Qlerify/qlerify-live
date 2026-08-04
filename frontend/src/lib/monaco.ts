import { api } from "./api.ts"

// Monaco is loaded from the SELF-HOSTED AMD bundle the server serves under
// /vendor/monaco/ — not bundled by Vite. That keeps the app bundle small and the
// CSP at script-src 'self' (the loader and its workers are same-origin).
type MonacoApi = typeof import("monaco-editor")

declare global {
  interface Window {
    monaco?: MonacoApi
    MonacoEnvironment?: { getWorkerUrl: () => string }
    require?: {
      (deps: string[], onOk: () => void, onErr: (e: unknown) => void): void
      config: (c: { paths: { vs: string } }) => void
    }
  }
}

const loadScriptOnce = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const s = document.createElement("script")
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(s)
  })

let loaderPromise: Promise<MonacoApi> | null = null

// The manifest supplies the same-origin loader/vs paths and the content-hashed
// base-worker URL, so nothing is hardcoded across Monaco upgrades.
export const loadMonaco = (): Promise<MonacoApi> => {
  if (window.monaco) {
    return Promise.resolve(window.monaco)
  }
  if (loaderPromise) {
    return loaderPromise
  }

  loaderPromise = (async () => {
    const man = await api<{ loaderUrl: string; vsPath: string; editorWorkerUrl: string | null }>(
      "/vendor/monaco/manifest.json",
    )
    if (man.editorWorkerUrl) {
      // Only the base editor worker routes through MonacoEnvironment; the language
      // workers self-resolve relative to vsPath.
      window.MonacoEnvironment = { getWorkerUrl: () => man.editorWorkerUrl! }
    }
    await loadScriptOnce(man.loaderUrl)
    window.require!.config({ paths: { vs: man.vsPath } })
    await new Promise<void>((resolve, reject) => {
      try {
        window.require!(["vs/editor/editor.main"], resolve, reject)
      } catch (e) {
        reject(e)
      }
    })
    return window.monaco!
  })().catch((e) => {
    loaderPromise = null
    throw e
  })

  return loaderPromise
}
