export const QlerifyMark = ({ cls }: { cls: string }) => (
  <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" className={`shrink-0 ${cls}`}>
    <path d="M23.7425 23.7122H29.5003C29.5169 23.7124 29.5305 23.7259 29.5306 23.7425V29.5003C29.5304 29.5168 29.5168 29.5304 29.5003 29.5306H23.7425C23.7259 29.5305 23.7124 29.5169 23.7122 29.5003V23.7425C23.7123 23.7258 23.7258 23.7123 23.7425 23.7122Z" />
    <path d="M15.0404 27.8003L3.07345 15.8334C2.8545 15.6144 2.85461 15.2597 3.07345 15.0406L15.0404 3.0737C15.2594 2.8547 15.6141 2.8547 15.8331 3.0737L27.8001 15.0406C28.0189 15.2597 28.019 15.6144 27.8001 15.8334L15.8331 27.8003C15.6142 28.0191 15.2594 28.0191 15.0404 27.8003Z" />
  </svg>
)

export const WorkflowGlyph = ({ cls }: { cls: string }) => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={`shrink-0 ${cls}`}>
    <rect x="2.5" y="3" width="7" height="5" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
    <rect x="10.5" y="12" width="7" height="5" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
    <path
      d="M6 8v3a1.5 1.5 0 0 0 1.5 1.5H10.5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const MenuCaret = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 text-stone-400 shrink-0">
    <path
      d="M7 8l3-3 3 3M7 12l3 3 3-3"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const Check = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 text-stone-900 shrink-0">
    <path
      d="M5 10.5l3.5 3.5L15 6.5"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const LockIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-stone-500 shrink-0">
    <path
      d="M6 9V6.5a4 4 0 0 1 8 0V9M5 9h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const SignOutIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-stone-500 shrink-0">
    <path
      d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3H15a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 15 17H9.5A1.5 1.5 0 0 1 8 15.5V14M11 10H3m0 0l2.5-2.5M3 10l2.5 2.5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
