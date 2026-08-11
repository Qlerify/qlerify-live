import { useState } from "react"
import { RoleChip, Table } from "@/components/Table.tsx"
import { api } from "@/lib/api.ts"
import type { AdminData } from "@/lib/types.ts"

type Issued = { subject: string; password: string } | null

export const MembersTab = ({ admin, reload }: { admin: AdminData; reload: () => Promise<void> }) => {
  const [subject, setSubject] = useState("")
  const [email, setEmail] = useState("")
  const [issued, setIssued] = useState<Issued>(null)

  // The server issues a one-time temporary password — capture it BEFORE reload.
  const add = async () => {
    try {
      const s = subject.trim()
      if (!s) {
        throw new Error("Username is required")
      }
      const r = await api<{ temporaryPassword?: string }>("/v1/memberships", {
        method: "POST",
        body: JSON.stringify({ subject: s, email: email.trim() || undefined }),
      })
      setIssued(r.temporaryPassword ? { subject: s, password: r.temporaryPassword } : null)
      setSubject("")
      setEmail("")
      await reload()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  const resetPassword = async (identityId: string, subj: string) => {
    if (!confirm(`Reset the password for "${subj}"?\n\nTheir current password stops working immediately and a new temporary one is issued (shown once).`)) {
      return
    }
    try {
      const r = await api<{ temporaryPassword?: string }>(
        `/v1/members/${encodeURIComponent(identityId)}/reset-password`,
        { method: "POST", body: "{}" },
      )
      setIssued(r.temporaryPassword ? { subject: subj, password: r.temporaryPassword } : null)
      await reload()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  return (
    <>
      {issued && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-amber-900">
                Temporary password for <span className="mono">{issued.subject}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="mono text-sm bg-white border border-amber-200 rounded px-2 py-1 select-all">
                  {issued.password}
                </code>
                <button
                  onClick={() => navigator.clipboard?.writeText(issued.password).catch(() => {})}
                  className="text-xs px-2 py-1 rounded border border-amber-300 text-amber-800 hover:bg-amber-100"
                >
                  Copy
                </button>
              </div>
              <div className="text-xs text-amber-700 mt-1.5">
                Shown once. Share it over a secure channel; the member must change it on first sign-in.
              </div>
            </div>
            <button
              onClick={() => setIssued(null)}
              aria-label="Dismiss"
              className="text-amber-700 hover:text-amber-900 text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="mb-4 flex items-end gap-2">
        <div>
          <label className="block text-xs text-stone-500 mb-1">Username (IdP subject)</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="jane@corp"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-stone-500 mb-1">Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="optional"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
          />
        </div>
        <button onClick={add} className="px-3 py-1.5 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-800">
          Add member
        </button>
      </div>
      <div className="text-xs text-stone-500 mb-3">
        Inviting a member issues a one-time temporary password (shown once below). With single sign-on not yet
        configured, share it over a secure channel — the member changes it on first sign-in.
      </div>

      <Table headers={["Username", "Email", "Roles", "Status", ""]} empty="No members." hasRows={admin.members.length > 0}>
        {admin.members.map((m) => (
          <tr key={m.identityId}>
            <td className="px-4 py-2 mono text-xs">{m.subject}</td>
            <td className="px-4 py-2 text-stone-600">{m.primaryEmail || "—"}</td>
            <td className="px-4 py-2">
              {(m.roles || []).length ? (
                (m.roles || []).map((r) => <RoleChip key={r} role={r} />)
              ) : (
                <span className="text-stone-400">—</span>
              )}
            </td>
            <td className="px-4 py-2 text-stone-500">{m.status || "active"}</td>
            <td className="px-4 py-2 text-right">
              <button
                onClick={() => resetPassword(m.identityId, m.subject)}
                className="text-xs px-2 py-1 rounded border border-stone-300 text-stone-700 hover:bg-stone-50"
              >
                Reset password
              </button>
            </td>
          </tr>
        ))}
      </Table>
    </>
  )
}
