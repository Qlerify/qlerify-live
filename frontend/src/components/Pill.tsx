import { STATUS_TONE } from "../lib/tone.ts"

type Props = {
  text: string
  status?: string
}

export const Pill = ({ text, status }: Props) => {
  const tone = STATUS_TONE[status || ""] || "bg-stone-100 text-stone-700"
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${tone}`}>
      {text}
    </span>
  )
}
