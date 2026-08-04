export const StatusDot = ({ status }: { status: string }) => {
  const orphan = status === "orphaned"
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${orphan ? "bg-rose-500" : "bg-emerald-500"}`}
      title={orphan ? "Orphaned — target table missing" : "Active"}
    />
  )
}
