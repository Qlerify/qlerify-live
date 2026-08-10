import { useStore } from "@/lib/store.ts"

export const RegistryBanner = () => {
  const registryError = useStore((s) => s.registryError)

  if (!registryError) {
    return null
  }

  return (
    <div className="bg-rose-600 text-white px-6 py-3 text-sm shadow">
      <div className="font-semibold">⚠ This workflow's model couldn't be loaded</div>
      <div className="mt-0.5 opacity-90">{registryError}</div>
      <div className="mt-1 text-xs opacity-80">
        The event registry couldn't be built from the current model. Open the <b>Model</b> tab and replace it with a
        valid Qlerify model.
      </div>
    </div>
  )
}
