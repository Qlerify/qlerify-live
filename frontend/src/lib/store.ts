import { create } from "zustand"
import type { Me } from "./api.ts"
import type { CaseRow, Meta } from "./types.ts"
import { DEFAULT_META } from "./types.ts"

type Toast = { ok: boolean; text: string } | null

type State = {
  me: Me | null
  orgs: NonNullable<Me["organizations"]>
  booting: boolean

  cases: CaseRow[]
  events: unknown[]
  meta: Meta
  busy: boolean
  registryError: string | null

  orgMenuOpen: boolean
  wfMenuOpen: boolean
  acctMenuOpen: boolean
  orgMemberCount: number | null
  orgMemberCountFor: string | null

  newOrgOpen: boolean
  newOrgBusy: boolean
  newOrgErr: string | null
  newWfOpen: boolean
  newWfBusy: boolean
  newWfErr: string | null

  toast: Toast

  set: (patch: Partial<State>) => void
  closeMenus: () => void
  showToast: (t: Toast) => void
}

export const useStore = create<State>((set) => ({
  me: null,
  orgs: [],
  booting: true,

  cases: [],
  events: [],
  meta: DEFAULT_META,
  busy: false,
  registryError: null,

  orgMenuOpen: false,
  wfMenuOpen: false,
  acctMenuOpen: false,
  orgMemberCount: null,
  orgMemberCountFor: null,

  newOrgOpen: false,
  newOrgBusy: false,
  newOrgErr: null,
  newWfOpen: false,
  newWfBusy: false,
  newWfErr: null,

  toast: null,

  set: (patch) => set(patch),

  closeMenus: () => set({ orgMenuOpen: false, wfMenuOpen: false, acctMenuOpen: false }),

  showToast: (toast) => {
    set({ toast })
    if (toast) {
      setTimeout(() => set({ toast: null }), 3000)
    }
  },
}))

export const currentOrgName = (me: Me | null, orgs: State["orgs"]) => {
  const id = me?.organizationId
  const o = (orgs || []).find((x) => x.id === id)
  if (o) {
    return o.name || o.slug || "—"
  }
  return id ? id.slice(0, 8) : "—"
}
