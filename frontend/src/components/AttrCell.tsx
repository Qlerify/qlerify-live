import { attrLines } from "@/lib/format.ts"

// Capped at 4 lines with a "+N more" hint so one rich field can't blow up the row.
export const AttrCell = ({ value }: { value: unknown }) => {
  const lines = attrLines(value)

  if (lines.length === 0) {
    return <>—</>
  }
  if (lines.length === 1) {
    return <>{lines[0]}</>
  }

  return (
    <>
      {lines.slice(0, 4).map((s, i) => (
        <div key={i} className="text-xs leading-snug">
          {s}
        </div>
      ))}
      {lines.length > 4 && <div className="text-[10px] text-stone-400">+{lines.length - 4} more</div>}
    </>
  )
}
