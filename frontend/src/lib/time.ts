// Rendered in UTC so it's stable regardless of the viewer's timezone (businessAt
// is a date carried in the event data).
export const fmtBizDate = (iso?: string | null): string | null => {
  if (!iso) {
    return null
  }
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
}

export const minutesBetween = (isoA?: string | null, isoB?: string | null): number | null => {
  if (!isoA || !isoB) {
    return null
  }
  return Math.round((new Date(isoB).getTime() - new Date(isoA).getTime()) / 60_000)
}

// Minutes within the hour, hours within the day, days beyond — so the timeline
// reads naturally whether a model's steps are minutes or weeks apart.
export const fmtGap = (min: number): string => {
  if (min < 60) {
    return `+${min}m`
  }
  const h = Math.floor(min / 60)
  const mm = min % 60
  if (h < 24) {
    return mm ? `+${h}h${mm}m` : `+${h}h`
  }
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh ? `+${d}d${hh}h` : `+${d}d`
}

export const timeAgo = (iso?: string | null): string => {
  if (!iso) {
    return ""
  }
  const then = new Date(iso).getTime()
  if (isNaN(then)) {
    return ""
  }
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (sec < 45) {
    return "just now"
  }
  const min = Math.round(sec / 60)
  if (min < 60) {
    return `${min}m ago`
  }
  const h = Math.floor(min / 60)
  if (h < 24) {
    return `${h}h ago`
  }
  const d = Math.floor(h / 24)
  if (d < 30) {
    return `${d}d ago`
  }
  const mo = Math.floor(d / 30)
  if (mo < 12) {
    return `${mo}mo ago`
  }
  return `${Math.floor(mo / 12)}y ago`
}
