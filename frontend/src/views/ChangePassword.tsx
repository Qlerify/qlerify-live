import { useState } from "react"
import { QlerifyMark } from "@/components/Icons.tsx"
import { AUTH, api } from "@/lib/api.ts"
import { navigate } from "@/lib/router.ts"
import { useStore } from "@/lib/store.ts"

export const ChangePassword = ({ forced, returnTo }: { forced: boolean; returnTo: string }) => {
  const me = useStore((s) => s.me)
  const set = useStore((s) => s.set)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (next !== confirm) {
      setError("The new passwords don't match.")
      return
    }
    if (next.length < 10) {
      setError("New password must be at least 10 characters.")
      return
    }
    try {
      const r = await api<{ token?: string }>("/v1/account/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      if (r.token) {
        AUTH.setSession(r.token)
      }
      set({ me: null })
      navigate(returnTo || "#org")
    } catch {
      setError("Couldn't update the password — check your current password.")
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
      <form onSubmit={submit} className="w-80 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <span style={{ color: "#50E593" }}>
            <QlerifyMark cls="h-6 w-6" />
          </span>
          <span className="text-lg font-semibold">
            Qlerify<span className="text-amber-500">·</span>Live
          </span>
        </div>
        <div className="text-base font-semibold text-stone-800 mb-1">Change password</div>
        <div className="text-sm text-stone-500 mb-4">
          {forced
            ? "Your account uses a temporary password. Set your own to continue."
            : `Update the password for ${me?.subject || ""}.`}
        </div>
        {error && <div className="text-sm text-rose-600 mb-3">{error}</div>}
        <label className="block text-xs font-medium text-stone-600 mb-1">Current password</label>
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <label className="block text-xs font-medium text-stone-600 mb-1">New password</label>
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <label className="block text-xs font-medium text-stone-600 mb-1">Confirm new password</label>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full mb-4 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <button className="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800">
          Update password
        </button>
        {!forced && (
          <button
            type="button"
            onClick={() => navigate(returnTo || "#org")}
            className="w-full mt-2 rounded-md border border-stone-300 py-2 text-sm hover:bg-stone-50"
          >
            Cancel
          </button>
        )}
      </form>
    </div>
  )
}
