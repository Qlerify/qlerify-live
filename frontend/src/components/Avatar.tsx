const PALETTE = [
  ["bg-sky-100", "text-sky-700"],
  ["bg-violet-100", "text-violet-700"],
  ["bg-emerald-100", "text-emerald-700"],
  ["bg-amber-100", "text-amber-700"],
  ["bg-rose-100", "text-rose-700"],
  ["bg-fuchsia-100", "text-fuchsia-700"],
  ["bg-teal-100", "text-teal-700"],
  ["bg-indigo-100", "text-indigo-700"],
]

// Same seed → same colour, so an org keeps its identity across the app.
const orgColor = (seed?: string): string[] => {
  const s = String(seed || "")
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return PALETTE[h % PALETTE.length]!
}

export const initials = (name?: string): string => {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) {
    return "—"
  }
  const two = parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!
  return two.toUpperCase()
}

type Org = { id?: string; name?: string; slug?: string }

export const OrgAvatar = ({ org, sizeCls, textCls }: { org?: Org; sizeCls: string; textCls: string }) => {
  const [bg, fg] = orgColor(org?.id || org?.slug || org?.name)
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md font-semibold shrink-0 ${bg} ${fg} ${sizeCls} ${textCls}`}
    >
      {initials(org?.name || org?.slug)}
    </span>
  )
}

// Circle (orgs use rounded squares) so person-vs-organisation reads at a glance;
// a superuser gets an amber ring.
export const UserAvatar = ({
  subject,
  isSuper,
  sizeCls = "h-6 w-6",
  textCls = "text-[11px]",
}: {
  subject?: string
  isSuper?: boolean
  sizeCls?: string
  textCls?: string
}) => {
  const ring = isSuper ? " ring-2 ring-amber-400/80" : ""
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold shrink-0 bg-stone-600 text-stone-50 ${sizeCls} ${textCls}${ring}`}
    >
      {initials(subject)}
    </span>
  )
}
