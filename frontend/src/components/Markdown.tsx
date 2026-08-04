import { Fragment, type ReactNode } from "react"

// Bold before italic, so ** is never consumed as a single *.
const INLINE = /\*\*([^*]+?)\*\*|\*(?!\s)([^*]+?)\*|`([^`]+?)`/g

const inline = (text: string): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index))
    }
    const key = out.length
    if (m[1] !== undefined) {
      out.push(<b key={key}>{m[1]}</b>)
    } else if (m[2] !== undefined) {
      out.push(<i key={key}>{m[2]}</i>)
    } else {
      out.push(
        <code key={key} className="bg-stone-100 px-1 py-0.5 rounded text-[12px] mono">
          {m[3]}
        </code>,
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length) {
    out.push(text.slice(last))
  }
  return out
}

const cells = (line: string) =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim())

const table = (lines: string[], key: number) => {
  const header = cells(lines[0]!)
  const rows = lines.slice(2).map(cells)
  return (
    <div key={key} className="overflow-x-auto my-2">
      <table className="text-[12px] w-full border-collapse">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i} className="text-left font-semibold px-2 py-1 border-b border-stone-300 bg-stone-50">
                {inline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1 border-b border-stone-100 align-top">
                  {inline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const isSpecial = (l: string) =>
  /^\s*\|/.test(l) || /^---+\s*$/.test(l) || /^#{1,6}\s/.test(l) || /^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)

// Lightweight markdown: tables, rules, headings, lists, paragraphs.
export const Markdown = ({ text }: { text: string }) => {
  const lines = String(text).split("\n")
  const blocks: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === "") {
      i++
      continue
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|?\s*$/.test(lines[i + 1]!)) {
      const tableLines = [line]
      i++
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        tableLines.push(lines[i]!)
        i++
      }
      blocks.push(table(tableLines, blocks.length))
      continue
    }

    if (/^---+\s*$/.test(line)) {
      blocks.push(<hr key={blocks.length} className="my-2 border-stone-200" />)
      i++
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.+)$/)
    if (h) {
      const cls =
        h[1]!.length <= 2 ? "text-sm font-semibold mt-2 mb-1" : "text-[13px] font-semibold mt-2 mb-1 text-stone-700"
      blocks.push(
        <div key={blocks.length} className={cls}>
          {inline(h[2]!)}
        </div>,
      )
      i++
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ""))
        i++
      }
      blocks.push(
        <ul key={blocks.length} className="list-disc ml-5 my-1 space-y-0.5">
          {items.map((it, k) => (
            <li key={k}>{inline(it)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ""))
        i++
      }
      blocks.push(
        <ol key={blocks.length} className="list-decimal ml-5 my-1 space-y-0.5">
          {items.map((it, k) => (
            <li key={k}>{inline(it)}</li>
          ))}
        </ol>,
      )
      continue
    }

    const para = [line]
    i++
    while (i < lines.length && lines[i]!.trim() !== "" && !isSpecial(lines[i]!)) {
      para.push(lines[i]!)
      i++
    }
    blocks.push(
      <p key={blocks.length} className="my-1">
        {para.map((l, k) => (
          <Fragment key={k}>
            {k > 0 && <br />}
            {inline(l)}
          </Fragment>
        ))}
      </p>,
    )
  }

  return <>{blocks}</>
}
