import { useEffect, useState } from "react"
import { AUTH, setUnauthorizedHandler, whoami } from "./lib/api.ts"
import { navigate, useRoute, WORKFLOW_SCOPED_VIEWS } from "./lib/router.ts"
import { useStore } from "./lib/store.ts"
import { TenantBar } from "./shell/TenantBar.tsx"
import { SectionBar } from "./shell/SectionBar.tsx"
import { RegistryBanner } from "./shell/RegistryBanner.tsx"
import { VIEWS } from "./views/registry.ts"
import { NewOrgDialog } from "./shell/NewOrgDialog.tsx"
import { NewWorkflowDialog } from "./shell/NewWorkflowDialog.tsx"
import { Toast } from "./shell/Toast.tsx"
import { Login } from "./views/Login.tsx"
import { ChangePassword } from "./views/ChangePassword.tsx"
import { EmptyOrg } from "./views/EmptyOrg.tsx"
import { NoOrg } from "./views/NoOrg.tsx"
import { NotPorted } from "./views/NotPorted.tsx"

const Loading = () => (
  <main className="flex-1 flex items-center justify-center p-8">
    <div className="flex items-center gap-3 text-stone-500">
      <div className="w-5 h-5 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
      <span className="text-sm">Loading…</span>
    </div>
  </main>
)

export const App = () => {
  const route = useRoute()
  const { me, booting, set } = useStore()
  const [cpReturn, setCpReturn] = useState("#org")

  useEffect(() => {
    setUnauthorizedHandler(() => {
      set({ me: null })
      if (location.hash !== "#login") {
        navigate("#login")
      }
    })
  }, [set])

  // Load the tenant context whenever it's missing (boot, login, org/workflow switch).
  useEffect(() => {
    if (route.view === "login") {
      set({ booting: false })
      return
    }
    if (me) {
      return
    }

    let live = true
    set({ booting: true })
    whoami().then((m) => {
      if (!live) {
        return
      }
      if (!m) {
        set({ me: null, orgs: [], booting: false })
        if (location.hash !== "#login") {
          navigate("#login")
        }
        return
      }
      if (WORKFLOW_SCOPED_VIEWS.has(route.view) && !AUTH.workflow() && m.workflowId) {
        AUTH.setWorkflow(m.workflowId)
      }
      set({ me: m, orgs: m.organizations || [], booting: false })
    })

    return () => {
      live = false
    }
  }, [me, route.view, set])

  useEffect(() => {
    if (route.view !== "change-password") {
      setCpReturn(location.hash || "#org")
    }
  }, [route.view])

  if (route.view === "login") {
    return <Login />
  }
  if (booting || !me) {
    return <Loading />
  }
  // An admin-issued temporary password blocks everything until it's replaced.
  if (me.mustChangePassword) {
    return <ChangePassword forced returnTo="#org" />
  }
  if (route.view === "change-password") {
    return <ChangePassword forced={false} returnTo={cpReturn} />
  }
  if (!me.organizationId) {
    return <NoOrg />
  }

  const emptyOrg = (me.workflows || []).length === 0
  const View = VIEWS[route.view]

  let body = View ? <View /> : <NotPorted view={route.view} />
  if (emptyOrg && route.view !== "admin") {
    body = <EmptyOrg />
  }

  return (
    <>
      <div className="flex flex-col min-h-screen">
        <TenantBar />
        <SectionBar view={route.view} />
        <RegistryBanner />
        {body}
      </div>
      <NewOrgDialog />
      <NewWorkflowDialog />
      <Toast />
    </>
  )
}
