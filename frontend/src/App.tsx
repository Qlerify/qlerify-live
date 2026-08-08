import { useEffect, useState } from "react"
import { AUTH, setTenantHandlers, setUnauthorizedHandler, whoami } from "./lib/api.ts"
import { applyDomainRole } from "./lib/role.ts"
import { deactivateConnectorChat, resetChatState, syncChatScope } from "./lib/chatData.ts"
import { navigate, useRoute, WORKFLOW_SCOPED_VIEWS } from "./lib/router.ts"
import { useStore } from "./lib/store.ts"
import { TenantBar } from "./shell/TenantBar.tsx"
import { SectionBar } from "./shell/SectionBar.tsx"
import { RegistryBanner } from "./shell/RegistryBanner.tsx"
import { Loading } from "./components/Loading.tsx"
import { VIEWS } from "./views/registry.ts"
import { NewOrgDialog } from "./shell/NewOrgDialog.tsx"
import { NewWorkflowDialog } from "./shell/NewWorkflowDialog.tsx"
import { Toast } from "./shell/Toast.tsx"
import { ChatPanel } from "./shell/ChatPanel.tsx"
import { Overlay } from "./components/Overlay.tsx"
import { Login } from "./views/Login.tsx"
import { ChangePassword } from "./views/ChangePassword.tsx"
import { EmptyOrg } from "./views/EmptyOrg.tsx"
import { NoOrg } from "./views/NoOrg.tsx"
import { NotPorted } from "./views/NotPorted.tsx"

export const App = () => {
  const route = useRoute()
  const { me, booting, chatOpen, set } = useStore()
  const [cpReturn, setCpReturn] = useState("#org")

  useEffect(() => {
    setUnauthorizedHandler(() => {
      set({ me: null })
      if (location.hash !== "#login") {
        navigate("#login")
      }
    })
    setTenantHandlers({
      scopeChange: () => {
        // Org/workflow switched: drop the per-workflow derived slices so a
        // stale frontier or AI ranking never renders (or reorders panels) for
        // the new tenant — recs in particular is only refetched by #todo/Detail.
        useStore.getState().set({ recs: null, nextActions: null, caseNextActions: null })
        syncChatScope()
      },
      signOut: () => {
        useStore.getState().set({ recs: null, nextActions: null, caseNextActions: null })
        resetChatState()
      },
    })
  }, [set])

  // The connector-builder thread is only live inside the explorer.
  useEffect(() => {
    if (route.view !== "bcs") {
      deactivateConnectorChat()
    }
  }, [route.view])

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
      // Re-resolve the acting lane on every tenant (re)load: the mapping and
      // the per-workflow pick both scope to the now-known workflow.
      applyDomainRole(m)
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
      <div
        className={`${chatOpen ? "mr-[420px]" : ""} flex flex-col min-h-screen transition-[margin-right] duration-200`}
      >
        <TenantBar />
        <SectionBar view={route.view} />
        <RegistryBanner />
        {body}
      </div>
      <ChatPanel view={route.view} />
      <NewOrgDialog />
      <NewWorkflowDialog />
      <Toast />
      <Overlay />
    </>
  )
}
