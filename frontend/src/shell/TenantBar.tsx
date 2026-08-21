import { useEffect } from "react"
import { OrgAvatar, UserAvatar } from "@/components/Avatar.tsx"
import { QlerifyMark, WorkflowGlyph, MenuCaret, Check, LockIcon, SignOutIcon } from "@/components/Icons.tsx"
import { AUTH, api } from "@/lib/api.ts"
import { navigate } from "@/lib/router.ts"
import { useStore, currentOrgName } from "@/lib/store.ts"

const AccountMenu = ({ onClose }: { onClose: () => void }) => {
  const me = useStore((s) => s.me)
  const set = useStore((s) => s.set)
  const subject = me?.subject || "system"
  const isAdmin = !!me?.isPlatformAdmin

  const signOut = async () => {
    set({ acctMenuOpen: false })
    try {
      await api("/v1/auth/logout", { method: "POST", body: "{}" })
    } catch {
      /* ignore */
    }
    AUTH.clear()
    set({ me: null, orgs: [] })
    navigate("#login")
  }

  const openChangePassword = () => {
    set({ acctMenuOpen: false })
    navigate("#change-password")
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="menu"
        aria-label="Account"
        className="absolute right-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-stone-200 bg-white shadow-xl text-stone-900 overflow-hidden"
      >
        <div className="p-3">
          <div className="flex items-center gap-3">
            <UserAvatar subject={subject} isSuper={isAdmin} sizeCls="h-10 w-10" textCls="text-sm" />
            <div className="min-w-0">
              <div className="font-semibold text-stone-900 truncate">{subject}</div>
              <div className={`text-xs truncate ${isAdmin ? "text-amber-600 font-medium" : "text-stone-500"}`}>
                {isAdmin ? "Platform superuser" : "Member"}
              </div>
            </div>
          </div>
          {isAdmin && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-2.5 py-2 text-[12px] leading-snug text-amber-800">
              <span className="shrink-0">⚡</span>
              <span>You can act across every organization. Every cross-tenant action is audited.</span>
            </div>
          )}
        </div>
        <button
          role="menuitem"
          onClick={openChangePassword}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-stone-200 hover:bg-stone-50 text-left"
        >
          <LockIcon />
          <span className="text-sm font-medium text-stone-800">Change password</span>
        </button>
        <button
          role="menuitem"
          onClick={signOut}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-stone-200 hover:bg-stone-50 text-left"
        >
          <SignOutIcon />
          <span className="text-sm font-medium text-stone-800">Sign out</span>
        </button>
      </div>
    </>
  )
}

const OrgMenu = ({ onClose }: { onClose: () => void }) => {
  const { me, orgs, orgMemberCount, orgMemberCountFor, set } = useStore()
  const curId = me?.organizationId || ""
  const curOrg = orgs.find((o) => o.id === curId) || { id: curId, name: currentOrgName(me, orgs) }
  const count = orgMemberCountFor === curId ? orgMemberCount : null
  const subtitle = count != null ? `${count} member${count === 1 ? "" : "s"}` : curOrg.slug || ""

  // Member count is org-admin gated; a non-admin just keeps the slug fallback.
  useEffect(() => {
    if (!curId || orgMemberCountFor === curId) {
      return
    }
    set({ orgMemberCountFor: curId })
    api<unknown[]>("/v1/members")
      .then((m) => set({ orgMemberCount: Array.isArray(m) ? m.length : null }))
      .catch(() => set({ orgMemberCount: null }))
  }, [curId, orgMemberCountFor, set])

  const pick = (id: string) => {
    set({ orgMenuOpen: false })
    if (id === curId) {
      return
    }
    set({ orgMemberCount: null, orgMemberCountFor: null })
    AUTH.setOrg(id)
    set({ me: null })
    navigate("#org")
  }

  const openAdmin = () => {
    set({ orgMenuOpen: false })
    navigate("#admin")
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="menu"
        aria-label="Organisations"
        className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-xl border border-stone-200 bg-white shadow-xl text-stone-900 overflow-hidden"
      >
        <div className="p-3">
          <div className="flex items-center gap-3">
            <OrgAvatar org={curOrg} sizeCls="h-10 w-10" textCls="text-sm" />
            <div className="min-w-0">
              <div className="font-semibold text-stone-900 truncate">{curOrg.name || currentOrgName(me, orgs)}</div>
              {subtitle && <div className="text-xs text-stone-500 truncate">{subtitle}</div>}
            </div>
          </div>
          <button
            role="menuitem"
            onClick={openAdmin}
            className="mt-3 w-full px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50 text-left font-medium text-stone-800"
          >
            Organisation admin
          </button>
        </div>
        <div className="border-t border-stone-200 p-2">
          <div className="px-2 pt-1 pb-1.5 text-[11px] uppercase tracking-wide text-stone-400 font-semibold">
            My organisations
          </div>
          <div className="max-h-64 overflow-auto">
            {orgs.length === 0 && <div className="px-2 py-2 text-sm text-stone-400">No organisations.</div>}
            {orgs.map((o) => (
              <button
                key={o.id}
                role="menuitem"
                onClick={() => pick(o.id)}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-stone-100 text-left"
              >
                <OrgAvatar org={o} sizeCls="h-7 w-7" textCls="text-xs" />
                <span className="flex-1 text-sm text-stone-800 truncate">{o.name || o.slug}</span>
                {o.id === curId && <Check />}
              </button>
            ))}
          </div>
        </div>
        <button
          role="menuitem"
          onClick={() => set({ orgMenuOpen: false, newOrgOpen: true, newOrgErr: null })}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-stone-200 hover:bg-stone-50 text-left"
        >
          <span className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-stone-300 text-stone-500 text-lg leading-none">
            +
          </span>
          <span className="text-sm font-medium text-stone-800">Create new organisation</span>
        </button>
      </div>
    </>
  )
}

const WorkflowMenu = ({ onClose }: { onClose: () => void }) => {
  const { me, set } = useStore()
  const workflows = me?.workflows || []
  const curId = AUTH.workflow() || ""

  const pick = (id: string | null) => {
    set({ wfMenuOpen: false })
    if (id === curId) {
      return
    }
    AUTH.setWorkflow(id)
    set({
      me: null,
      dashLoaded: false,
      cases: [],
      events: [],
      flow: null,
      flowRows: null,
      nextActions: null,
      caseNextActions: null,
      recs: null,
      instance: null,
    })
    navigate(id ? "#" : "#org")
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="menu"
        aria-label="Workflows"
        className="absolute left-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-stone-200 bg-white shadow-xl text-stone-900 overflow-hidden"
      >
        <div className="p-2">
          <div className="max-h-72 overflow-auto">
            <button
              role="menuitem"
              onClick={() => pick(null)}
              className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-stone-100 text-left ${!curId ? "bg-stone-100" : ""}`}
            >
              <WorkflowGlyph cls="h-5 w-5 text-stone-400" />
              <span className={`flex-1 text-sm truncate ${!curId ? "text-stone-900 font-medium" : "text-stone-800"}`}>
                All workflows
              </span>
              {!curId && <Check />}
            </button>
            <div className="my-1 border-t border-stone-100" />
            {workflows.length === 0 && <div className="px-2 py-2 text-sm text-stone-400">No workflows.</div>}
            {workflows.map((w) => {
              const active = w.id === curId
              return (
                <button
                  key={w.id}
                  role="menuitem"
                  onClick={() => pick(w.id)}
                  className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-stone-100 text-left ${active ? "bg-stone-100" : ""}`}
                >
                  <WorkflowGlyph cls="h-5 w-5 text-stone-400" />
                  <span
                    className={`flex-1 text-sm truncate ${active ? "text-stone-900 font-medium" : "text-stone-800"}`}
                  >
                    {w.name}
                  </span>
                  {active && <Check />}
                </button>
              )
            })}
          </div>
        </div>
        <button
          role="menuitem"
          onClick={() => set({ wfMenuOpen: false, newWfOpen: true, newWfErr: null })}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-stone-200 hover:bg-stone-50 text-left"
        >
          <span className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-stone-300 text-stone-500 text-lg leading-none">
            +
          </span>
          <span className="text-sm font-medium text-stone-800">Create new workflow</span>
        </button>
      </div>
    </>
  )
}

export const TenantBar = () => {
  const { me, orgs, orgMenuOpen, wfMenuOpen, acctMenuOpen, set, closeMenus } = useStore()
  const subject = me?.subject || "system"
  const isAdmin = !!me?.isPlatformAdmin
  const curId = me?.organizationId || ""
  const curOrg = orgs.find((o) => o.id === curId) || { id: curId, name: currentOrgName(me, orgs) }
  const workflows = me?.workflows || []
  const emptyOrg = workflows.length === 0
  const selectedWf = AUTH.workflow() || ""
  const wfLabel = !selectedWf ? "All workflows" : workflows.find((w) => w.id === selectedWf)?.name || "Workflow"

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMenus()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [closeMenus])

  const goPortfolio = () => {
    closeMenus()
    AUTH.setWorkflow(null)
    navigate("#org")
  }

  return (
    <div className="bg-stone-900 text-stone-300 text-sm border-b border-stone-800">
      <div className="px-6 py-1.5 flex items-center gap-3">
        <button
          type="button"
          title="Portfolio — all workflows"
          onClick={goPortfolio}
          className="flex items-center gap-1.5 text-stone-100 rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800 px-1 py-0.5"
        >
          <QlerifyMark cls="h-4 w-4" />
          <span className="font-semibold tracking-tight">
            Qlerify<span className="text-amber-400">·</span>Live
          </span>
        </button>
        <span className="text-stone-500">›</span>

        <div className="relative flex items-center rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800">
          <a
            href="#org"
            title="Organisation portfolio"
            className="flex items-center gap-2 pl-1 pr-1 py-0.5 rounded-l-md"
          >
            <OrgAvatar org={curOrg} sizeCls="h-6 w-6" textCls="text-[11px]" />
            <span className="text-sm font-medium text-stone-100 max-w-[220px] truncate">
              {currentOrgName(me, orgs)}
            </span>
          </a>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={orgMenuOpen}
            title="Switch organisation"
            onClick={(e) => {
              e.stopPropagation()
              set({ orgMenuOpen: !orgMenuOpen, wfMenuOpen: false, acctMenuOpen: false })
            }}
            className="px-1.5 py-1 rounded-r-md border-l border-stone-700/60"
          >
            <MenuCaret />
          </button>
          {orgMenuOpen && <OrgMenu onClose={() => set({ orgMenuOpen: false })} />}
        </div>

        <span className="text-stone-500">›</span>

        {emptyOrg ? (
          <button
            onClick={() => set({ newWfOpen: true, newWfErr: null })}
            title="This organization has no workflows yet"
            className="text-sm text-amber-300 hover:text-amber-200"
          >
            + Create workflow
          </button>
        ) : (
          <div className="relative flex items-center rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800">
            <a
              href={selectedWf ? "#" : "#org"}
              title={selectedWf ? "This workflow's overview" : "Organisation portfolio — all workflows"}
              className="flex items-center gap-2 pl-1.5 pr-1 py-0.5 rounded-l-md"
            >
              <WorkflowGlyph cls="h-4 w-4 text-stone-400" />
              <span className="text-sm font-medium text-stone-100 max-w-[220px] truncate">{wfLabel}</span>
            </a>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={wfMenuOpen}
              title="Switch workflow"
              onClick={(e) => {
                e.stopPropagation()
                set({ wfMenuOpen: !wfMenuOpen, orgMenuOpen: false, acctMenuOpen: false })
              }}
              className="px-1.5 py-1 rounded-r-md border-l border-stone-700/60"
            >
              <MenuCaret />
            </button>
            {wfMenuOpen && <WorkflowMenu onClose={() => set({ wfMenuOpen: false })} />}
          </div>
        )}

        <div className="flex-1" />

        <div className="relative">
          <button
            aria-haspopup="menu"
            aria-expanded={acctMenuOpen}
            title={`Account — signed in as ${subject}`}
            onClick={() => set({ acctMenuOpen: !acctMenuOpen, orgMenuOpen: false, wfMenuOpen: false })}
            className="flex items-center gap-2 rounded-md border border-transparent hover:border-stone-700 hover:bg-stone-800 pl-1 pr-1.5 py-0.5"
          >
            {isAdmin && (
              <span
                className="text-[10px] uppercase font-bold tracking-wide px-1.5 py-px rounded bg-amber-500 text-stone-900"
                title="You are signed in as a platform superuser — every cross-tenant action is audited"
              >
                Superuser
              </span>
            )}
            <UserAvatar subject={subject} isSuper={isAdmin} />
            <MenuCaret />
          </button>
          {acctMenuOpen && <AccountMenu onClose={() => set({ acctMenuOpen: false })} />}
        </div>
      </div>
    </div>
  )
}
