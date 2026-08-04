import type { ReactNode } from "react"

type Props = {
  headers: string[]
  empty?: string
  children: ReactNode
  hasRows: boolean
}

export const Table = ({ headers, empty, children, hasRows }: Props) => (
  <div className="rounded-lg border border-stone-200 bg-white overflow-hidden">
    <table className="w-full text-sm">
      <thead className="bg-stone-50 border-b border-stone-200">
        <tr className="text-left text-[11px] uppercase tracking-wide text-stone-500">
          {headers.map((h, i) => (
            <th key={i} className="px-4 py-2 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        {hasRows ? (
          children
        ) : (
          <tr>
            <td className="px-4 py-6 text-stone-400" colSpan={headers.length}>
              {empty || "Nothing here yet."}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
)

const ROLE_TONE: Record<string, string> = {
  owner: "bg-purple-100 text-purple-800",
  org_admin: "bg-purple-100 text-purple-800",
  editor: "bg-sky-100 text-sky-800",
  viewer: "bg-stone-200 text-stone-700",
  deployer: "bg-amber-100 text-amber-800",
}

export const RoleChip = ({ role }: { role: string }) => (
  <span className={`text-[11px] px-1.5 py-px rounded ${ROLE_TONE[role] || "bg-stone-200 text-stone-700"}`}>
    {role}
  </span>
)
