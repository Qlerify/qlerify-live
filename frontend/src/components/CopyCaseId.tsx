import { useState } from "react"

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
    <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
    <path
      d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
    <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// Lives inside the row's <a>, so the click must be swallowed to copy without also
// navigating into the case.
export const CopyCaseId = ({ id }: { id: string }) => {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      // Non-secure contexts / no async clipboard API.
      const ta = document.createElement("textarea")
      ta.value = id
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand("copy")
      } catch {
        /* ignore */
      }
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const activate = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    copy()
  }

  return (
    <span
      role="button"
      tabIndex={0}
      title={copied ? "Copied!" : "Copy this case's ID to the clipboard"}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          activate(e)
        }
      }}
      className={`absolute top-1.5 right-1.5 z-10 ${copied ? "opacity-100 text-emerald-600" : "opacity-0 text-stone-400"} group-hover/case:opacity-100 focus:opacity-100 transition-opacity p-1 rounded hover:text-stone-700 hover:bg-stone-200/70 cursor-pointer`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </span>
  )
}
