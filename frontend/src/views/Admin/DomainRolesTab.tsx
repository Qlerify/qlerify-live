import { useCallback, useEffect, useState } from "react"
import { Table } from "@/components/Table.tsx"
import { AUTH, api } from "@/lib/api.ts"
import type { AdminData, DomainRoleList } from "@/lib/types.ts"

// Domain-role mapping: which member plays which model lane in which workflow.
// Personalization for the To do surfaces (whoami.domainRoles), NOT security —
// the PDP stays the boundary. Lanes come from the selected workflow's model;
// an assignment whose lane vanished after a model swap is flagged, not deleted.
export const DomainRolesTab = ({ admin }: { admin: AdminData; reload: () => Promise<void> }) => {
  const [wfId, setWfId] = useState(() => AUTH.workflow() || admin.workflows[0]?.id || "")
  const [data, setData] = useState<DomainRoleList | null>(null)
  const [identityId, setIdentityId] = useState("")
  const [lane, setLane] = useState("")
  const [err, setErr] = useState("")

  const load = useCallback(async () => {
    if (!wfId) {
      setData(null)
      return
    }
    setData(await api<DomainRoleList>(`/v1/domain-roles?workflowId=${encodeURIComponent(wfId)}`))
  }, [wfId])

  useEffect(() => {
    load().catch((e) => setErr((e as Error).message))
  }, [load])

  const add = async () => {
    setErr("")
    try {
      const member = identityId || admin.members[0]?.identityId
      // A pick that isn't one of THIS workflow's lanes (model swapped while the
      // tab was open) falls back to the first lane — what the select displays.
      const laneValid = !data || data.modelRoles.length === 0 || data.modelRoles.includes(lane)
      const domainRole = (laneValid ? lane : "") || data?.modelRoles[0]
      if (!member || !domainRole) {
        throw new Error("Pick a member and a role")
      }
      await api("/v1/domain-roles", {
        method: "POST",
        body: JSON.stringify({ workflowId: wfId, identityId: member, domainRole }),
      })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const remove = async (id: string) => {
    setErr("")
    try {
      await api(`/v1/domain-roles/${encodeURIComponent(id)}`, { method: "DELETE" })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const assignments = data?.assignments ?? []

  return (
    <>
      <div className="mb-4 flex items-end gap-2 flex-wrap">
        <div>
          <label className="block text-xs text-stone-500 mb-1">Workflow</label>
          <select
            value={wfId}
            onChange={(e) => {
              setWfId(e.target.value)
              setLane("") // each workflow has its own lanes — never carry a pick across
            }}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          >
            {admin.workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Member</label>
          <select
            value={identityId}
            onChange={(e) => setIdentityId(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          >
            {admin.members.map((m) => (
              <option key={m.identityId} value={m.identityId}>
                {m.subject}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Role (model lane)</label>
          {data && data.modelRoles.length > 0 ? (
            <select
              value={lane}
              onChange={(e) => setLane(e.target.value)}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
            >
              {data.modelRoles.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          ) : (
            <input
              value={lane}
              onChange={(e) => setLane(e.target.value)}
              placeholder="no model yet — type a role"
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
            />
          )}
        </div>
        <button onClick={add} className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">
          Assign role
        </button>
        {err && <span className="text-sm text-rose-700">{err}</span>}
      </div>
      <div className="text-xs text-stone-500 mb-3">
        Maps members to the model&rsquo;s roles (swimlanes) so the To&nbsp;do tab can default to &ldquo;my
        roles&rdquo; and future digests know who to address. This does not grant access — platform roles on the
        Roles tab do that.
      </div>

      <Table
        headers={["Member", "Role", "Granted", ""]}
        empty="No role assignments for this workflow yet."
        hasRows={assignments.length > 0}
      >
        {assignments.map((a) => (
          <tr key={a.id}>
            <td className="px-4 py-2 font-medium">{a.subject}</td>
            <td className="px-4 py-2">
              <span className="text-[11px] px-1.5 py-px rounded bg-stone-100 text-stone-700">{a.domainRole}</span>
              {!a.inModel && (
                <span
                  className="ml-2 text-[11px] px-1.5 py-px rounded bg-amber-100 text-amber-800"
                  title="This role is not in the workflow's current model — it may have been renamed or removed in a model swap. The assignment is kept so a swap back restores it."
                >
                  not in current model
                </span>
              )}
            </td>
            <td className="px-4 py-2 text-stone-400 text-xs mono">
              {(a.grantedAt || "").toString().slice(0, 10)}
            </td>
            <td className="px-4 py-2 text-right">
              <button
                onClick={() => remove(a.id)}
                className="text-xs px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50"
              >
                Remove
              </button>
            </td>
          </tr>
        ))}
      </Table>
    </>
  )
}
