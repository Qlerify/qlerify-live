import { useCallback, useEffect, useState } from "react"
import { useStore, currentOrgName } from "../../lib/store.ts"
import { ADMIN_TABS, loadAdmin } from "../../lib/adminData.ts"
import type { AdminData } from "../../lib/types.ts"
import { Loading } from "../../components/Loading.tsx"
import { GeneralTab } from "./GeneralTab.tsx"
import { MembersTab } from "./MembersTab.tsx"
import { DomainRolesTab } from "./DomainRolesTab.tsx"
import { AuditTab, EnvironmentsTab, MarkingsTab, RolesTab, WorkflowsTab, WorkspacesTab } from "./SimpleTabs.tsx"

export const Admin = () => {
  const { me, orgs } = useStore()
  const orgId = me?.organizationId
  const [tab, setTab] = useState("general")
  const [admin, setAdmin] = useState<AdminData | null>(null)

  const reload = useCallback(async () => {
    setAdmin(await loadAdmin(tab, orgId))
  }, [tab, orgId])

  useEffect(() => {
    reload().catch(() => {})
  }, [reload])

  const body = () => {
    if (!admin) {
      return <Loading />
    }
    switch (tab) {
      case "members":
        return <MembersTab admin={admin} reload={reload} />
      case "roles":
        return <RolesTab admin={admin} reload={reload} />
      case "domain-roles":
        return <DomainRolesTab admin={admin} reload={reload} />
      case "markings":
        return <MarkingsTab admin={admin} reload={reload} />
      case "environments":
        return <EnvironmentsTab admin={admin} reload={reload} />
      case "workspaces":
        return <WorkspacesTab admin={admin} reload={reload} />
      case "workflows":
        return <WorkflowsTab admin={admin} reload={reload} />
      case "audit":
        return <AuditTab admin={admin} />
      default:
        return <GeneralTab admin={admin} reload={reload} />
    }
  }

  return (
    <>
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
        <div className="px-6 pt-4 pb-2 flex items-center gap-4">
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-widest text-stone-500 font-semibold">
              Organization admin
            </div>
            <div className="text-stone-900 text-xl font-semibold leading-tight">{currentOrgName(me, orgs)}</div>
          </div>
        </div>
        <div className="px-6 pb-3 flex items-center gap-2">
          {ADMIN_TABS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-sm rounded-md ${tab === k ? "bg-stone-900 text-white" : "border border-stone-300 bg-white hover:bg-stone-50"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-auto p-6">{body()}</main>
    </>
  )
}
