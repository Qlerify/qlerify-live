import { useState } from "react"
import { useStore } from "@/lib/store.ts"
import { applyDomainRole, persistRolePick, storedRolePick } from "@/lib/role.ts"

// "Acting as" — which model lane the signed-in user plays. Options come from
// the loaded model's lanes (no extra fetch); ★ marks lanes the admin mapped to
// this user (whoami.domainRoles). Drives the x-role header on command posts;
// it is NOT an access control (the PDP is).
export const RolePicker = () => {
  const { events, me } = useStore()
  const [, bump] = useState(0)

  const roles = [...new Set((events || []).map((e) => e.role))].sort()
  if (!roles.length) {
    return null
  }
  const mapped = me?.domainRoles || []
  // Clamp to lanes the LOADED model declares: a stored pick or admin mapping
  // can go stale after a model swap, and the select must never sit on a value
  // absent from its options.
  const current = [storedRolePick(), ...mapped].find((r) => r && roles.includes(r)) || ""

  const onChange = (v: string) => {
    persistRolePick(v)
    applyDomainRole(me)
    bump((n) => n + 1)
  }

  return (
    <label
      className="flex items-center gap-2 text-sm text-stone-500"
      title={
        mapped.length
          ? `Your mapped role${mapped.length > 1 ? "s" : ""}: ${mapped.join(", ")} (★). Pick another to act as a different lane.`
          : "No role is mapped to you for this workflow — pick the lane you work in (an admin can map it permanently under Organization admin → Workflow roles)."
      }
    >
      <span className="text-[11px] uppercase tracking-wide font-semibold">Acting as</span>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-stone-300 bg-white px-2 py-1 text-sm text-stone-800"
      >
        {!current && <option value="">— pick your role —</option>}
        {roles.map((r) => (
          <option key={r} value={r}>
            {r}
            {mapped.includes(r) ? " ★" : ""}
          </option>
        ))}
      </select>
    </label>
  )
}
