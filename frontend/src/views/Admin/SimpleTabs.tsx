import { useState } from "react"
import { AUTH, api } from "../../lib/api.ts"
import { useStore } from "../../lib/store.ts"
import { RoleChip, Table } from "../../components/Table.tsx"
import type { AdminData } from "../../lib/types.ts"

type TabProps = { admin: AdminData; reload: () => Promise<void> }

const act = async (fn: () => Promise<void>, reload: () => Promise<void>) => {
  try {
    await fn()
    await reload()
  } catch (e) {
    alert((e as Error).message)
  }
}

export const RolesTab = ({ admin, reload }: TabProps) => {
  const me = useStore((s) => s.me)
  const [principal, setPrincipal] = useState("")
  const [role, setRole] = useState("owner")
  const [scope, setScope] = useState("organization")
  const [scopeId, setScopeId] = useState("")

  const add = () =>
    act(async () => {
      if (!principal.trim()) {
        throw new Error("Principal id is required")
      }
      await api("/v1/role-assignments", {
        method: "POST",
        body: JSON.stringify({
          principalId: principal.trim(),
          roleKey: role,
          scopeType: scope,
          scopeId: scopeId.trim() || me?.organizationId,
        }),
      })
      setPrincipal("")
      setScopeId("")
    }, reload)

  return (
    <>
      <div className="mb-4 flex items-end gap-2 flex-wrap">
        <div>
          <label className="block text-xs text-stone-500 mb-1">Principal id</label>
          <input
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            placeholder="identity id"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm mono"
          />
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          >
            {["owner", "editor", "viewer", "deployer", "org_admin"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Scope</label>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          >
            {["organization", "environment", "workspace", "workflow", "resource"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Scope id</label>
          <input
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            placeholder="(org id for org scope)"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm mono"
          />
        </div>
        <button onClick={add} className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">
          Assign role
        </button>
      </div>

      <Table headers={["Principal", "Type", "Role", "Scope"]} empty="No role assignments." hasRows={admin.roles.length > 0}>
        {admin.roles.map((r, i) => (
          <tr key={i}>
            <td className="px-4 py-2 mono text-xs">{r.principalId}</td>
            <td className="px-4 py-2 text-stone-500">{r.principalType}</td>
            <td className="px-4 py-2">
              <RoleChip role={r.roleKey} />
            </td>
            <td className="px-4 py-2 text-stone-600">
              {r.scopeType}: <span className="mono text-xs">{String(r.scopeId).slice(0, 12)}</span>
            </td>
          </tr>
        ))}
      </Table>
    </>
  )
}

export const MarkingsTab = ({ admin, reload }: TabProps) => {
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")

  const add = () =>
    act(async () => {
      if (!name.trim()) {
        throw new Error("Marking name is required")
      }
      await api("/v1/markings", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), description: desc.trim() || undefined }),
      })
      setName("")
      setDesc("")
    }, reload)

  return (
    <>
      <div className="mb-4 flex items-end gap-2">
        <div>
          <label className="block text-xs text-stone-500 mb-1">Marking</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="PII"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Description</label>
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="optional"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </div>
        <button onClick={add} className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">
          Add marking
        </button>
      </div>
      <div className="text-xs text-stone-500 mb-3">
        Markings are a mandatory access gate (MAC): a caller must hold every marking on a resource to access it,
        regardless of role.
      </div>

      <Table headers={["Marking", "Description"]} empty="No markings." hasRows={admin.markings.length > 0}>
        {admin.markings.map((m) => (
          <tr key={m.name}>
            <td className="px-4 py-2">
              <span className="text-[11px] px-1.5 py-px rounded bg-rose-100 text-rose-800">{m.name}</span>
            </td>
            <td className="px-4 py-2 text-stone-600">{m.description || "—"}</td>
          </tr>
        ))}
      </Table>
    </>
  )
}

export const EnvironmentsTab = ({ admin, reload }: TabProps) => {
  const [name, setName] = useState("")
  const [region, setRegion] = useState("")

  const add = () =>
    act(async () => {
      if (!name.trim()) {
        throw new Error("Environment name is required")
      }
      await api("/v1/environments", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), region: region.trim() || "local" }),
      })
      setName("")
      setRegion("")
    }, reload)

  return (
    <>
      <div className="mb-4 flex items-end gap-2">
        <div>
          <label className="block text-xs text-stone-500 mb-1">Environment</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="staging"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Region</label>
          <input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="local"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </div>
        <button onClick={add} className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">
          Add environment
        </button>
      </div>

      <Table headers={["Environment", "Region", "Lifecycle"]} empty="No environments." hasRows={admin.environments.length > 0}>
        {admin.environments.map((e) => (
          <tr key={e.id}>
            <td className="px-4 py-2 font-medium">{e.name}</td>
            <td className="px-4 py-2 text-stone-600">{e.region || "local"}</td>
            <td className="px-4 py-2 text-stone-500">{e.lifecycleState || "active"}</td>
          </tr>
        ))}
      </Table>
    </>
  )
}

export const WorkspacesTab = ({ admin, reload }: TabProps) => {
  const [name, setName] = useState("")
  const [envId, setEnvId] = useState("")

  const add = () =>
    act(async () => {
      if (!name.trim()) {
        throw new Error("Workspace name is required")
      }
      const environmentId = envId || admin.environments[0]?.id
      if (!environmentId) {
        throw new Error("Pick an environment")
      }
      await api("/v1/workspaces", { method: "POST", body: JSON.stringify({ name: name.trim(), environmentId }) })
      setName("")
    }, reload)

  return (
    <>
      <div className="mb-4 flex items-end gap-2">
        <div>
          <label className="block text-xs text-stone-500 mb-1">Workspace</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Finance"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Environment</label>
          <select
            value={envId}
            onChange={(e) => setEnvId(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          >
            {admin.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <button onClick={add} className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">
          Add workspace
        </button>
      </div>

      <Table headers={["Workspace", "Environment", "Lifecycle"]} empty="No workspaces." hasRows={admin.workspaces.length > 0}>
        {admin.workspaces.map((w) => (
          <tr key={w.id}>
            <td className="px-4 py-2 font-medium">{w.name}</td>
            <td className="px-4 py-2 mono text-xs text-stone-500">{String(w.environmentId).slice(0, 12)}</td>
            <td className="px-4 py-2 text-stone-500">{w.lifecycleState || "active"}</td>
          </tr>
        ))}
      </Table>
    </>
  )
}

export const WorkflowsTab = ({ admin, reload }: TabProps) => {
  const set = useStore((s) => s.set)
  const [name, setName] = useState("")
  const [wsId, setWsId] = useState("")

  const add = () =>
    act(async () => {
      if (!name.trim()) {
        throw new Error("Workflow name is required")
      }
      const workspaceId = wsId || admin.workspaces[0]?.id
      if (!workspaceId) {
        throw new Error("Pick a workspace")
      }
      await api("/v1/workflows", { method: "POST", body: JSON.stringify({ name: name.trim(), workspaceId }) })
      setName("")
    }, reload)

  const remove = (id: string, wfName: string) =>
    act(async () => {
      if (!confirm(`Delete workflow "${wfName}"?\n\nThis permanently drops its tables, all data, run history, and model versions. This cannot be undone.`)) {
        return
      }
      await api(`/v1/workflows/${encodeURIComponent(id)}`, { method: "DELETE" })
      if (AUTH.workflow() === id) {
        AUTH.setWorkflow(null)
      }
      set({ me: null })
    }, reload)

  return (
    <>
      <div className="mb-4 flex items-end gap-2">
        <div>
          <label className="block text-xs text-stone-500 mb-1">Workflow</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Q3 Forecast"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Workspace</label>
          <select
            value={wsId}
            onChange={(e) => setWsId(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          >
            {admin.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <button onClick={add} className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">
          Add workflow
        </button>
      </div>
      <div className="text-xs text-stone-500 mb-3">
        A new workflow starts empty — point it at your own Qlerify model (⚙ Set model) to give it data. Switch
        workflows from the breadcrumb at the top. Deleting a workflow permanently drops its tables, data, run
        history, and model versions.
      </div>

      <Table
        headers={["Workflow", "Workspace", "Lifecycle", ""]}
        empty="No workflows yet — create one and point it at a Qlerify model."
        hasRows={admin.workflows.length > 0}
      >
        {admin.workflows.map((w) => (
          <tr key={w.id}>
            <td className="px-4 py-2 font-medium">{w.name}</td>
            <td className="px-4 py-2 mono text-xs text-stone-500">{String(w.workspaceId).slice(0, 12)}</td>
            <td className="px-4 py-2 text-stone-500">{w.lifecycleState || "active"}</td>
            <td className="px-4 py-2 text-right">
              <button
                onClick={() => remove(w.id, w.name)}
                className="text-xs px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50"
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
      </Table>
    </>
  )
}

export const AuditTab = ({ admin }: { admin: AdminData }) => {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [checking, setChecking] = useState(false)

  const verify = async () => {
    setChecking(true)
    setResult(null)
    try {
      const r = await api<{ ok: boolean; length: number; brokenAtSeq?: number }>("/v1/audit/verify")
      setResult(
        r.ok
          ? { ok: true, text: `✓ intact — ${r.length} events, hash chain verified` }
          : { ok: false, text: `✗ tampering detected at seq ${r.brokenAtSeq}` },
      )
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message })
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={verify}
          className="px-3 py-1.5 text-sm rounded-md border border-stone-300 bg-white hover:bg-stone-50"
        >
          Verify chain integrity
        </button>
        <span className={`text-sm ${result ? (result.ok ? "text-emerald-700" : "text-rose-700") : "text-stone-500"}`}>
          {checking ? "verifying…" : result?.text || ""}
        </span>
      </div>

      <Table
        headers={["#", "Action", "Decision", "Target", "Reason", "When"]}
        empty="No audit events."
        hasRows={admin.audit.length > 0}
      >
        {admin.audit.map((ev) => (
          <tr key={ev.seq}>
            <td className="px-4 py-2 mono text-xs text-stone-500">{ev.seq}</td>
            <td className="px-4 py-2 font-medium">{ev.action}</td>
            <td className="px-4 py-2">
              {ev.decision ? (
                <span
                  className={`text-[11px] px-1.5 py-px rounded ${ev.decision === "allow" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}
                >
                  {ev.decision}
                </span>
              ) : (
                "—"
              )}
            </td>
            <td className="px-4 py-2 text-stone-600">{ev.targetRef || "—"}</td>
            <td className="px-4 py-2 text-stone-500 text-xs">{ev.reason || ""}</td>
            <td className="px-4 py-2 text-stone-400 text-xs mono">
              {(ev.occurredAt || "").toString().slice(0, 19).replace("T", " ")}
            </td>
          </tr>
        ))}
      </Table>
    </>
  )
}
