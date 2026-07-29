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
