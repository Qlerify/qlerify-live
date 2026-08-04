import { useState } from "react"
import { AUTH, api } from "../lib/api.ts"
import { navigate } from "../lib/router.ts"
import { QlerifyMark } from "../components/Icons.tsx"
import { useStore } from "../lib/store.ts"

export const Login = () => {
  const [subject, setSubject] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const set = useStore((s) => s.set)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    AUTH.clear()
    try {
      const r = await api<{ token: string; organizations?: { id: string }[] }>("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), password }),
      })
      AUTH.setSession(r.token)
      AUTH.setOrg((r.organizations || [])[0]?.id || null)
      set({ me: null })
      navigate("#org")
    } catch {
      setError("Invalid username or password.")
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
        <div className="text-sm text-stone-500 mb-4">Sign in to the multi-tenant console</div>
        {error && <div className="text-sm text-rose-600 mb-3">{error}</div>}
        <label className="block text-xs font-medium text-stone-600 mb-1">Username</label>
        <input
          autoComplete="username"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full mb-3 rounded-md border border-stone-300 px-3 py-2 text-sm"
          placeholder="superadmin"
        />
        <label className="block text-xs font-medium text-stone-600 mb-1">Password</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <button className="w-full rounded-md bg-stone-900 text-white py-2 text-sm font-medium hover:bg-stone-800">
          Sign in
        </button>
      </form>
    </div>
  )
}
