import { Pill } from "@/components/Pill.tsx"

export const FieldValue = ({ name, value }: { name: string; value: unknown }) => {
  if (value == null || value === "") {
    return <>—</>
  }
  if (name === "status") {
    return <Pill text={String(value)} status={String(value)} />
  }
  if (typeof value === "object") {
    return <span className="mono text-[11px] text-stone-500">{JSON.stringify(value)}</span>
  }
  return <>{String(value)}</>
}
