// Temporary Phase 0 check page — replaced by the real shell in Phase 1.

import { useEffect, useState } from "react";

type Check = { label: string; ok: boolean | null; detail: string };

// Without 'unsafe-eval' in the CSP, building code from a string throws.
function checkEvalBlocked(): Check {
  try {
    const v = new Function("return 1 + 1")();
    return {
      label: "CSP blocks dynamic code evaluation",
      ok: false,
      detail: `new Function() returned ${v} — 'unsafe-eval' is still allowed`,
    };
  } catch (err) {
    return {
      label: "CSP blocks dynamic code evaluation",
      ok: true,
      detail: `blocked (${(err as Error).name})`,
    };
  }
}

function Row({ check }: { check: Check }) {
  const tone =
    check.ok === null
      ? "bg-stone-200 text-stone-700"
      : check.ok
        ? "bg-emerald-100 text-emerald-800"
        : "bg-rose-100 text-rose-800";
  const mark = check.ok === null ? "…" : check.ok ? "✓" : "✗";
  return (
    <li className="flex items-start gap-3 py-2.5 border-t border-stone-100 first:border-t-0">
      <span
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${tone}`}
      >
        {mark}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-stone-800">{check.label}</span>
        <span className="mono block text-[11px] text-stone-500 break-words">{check.detail}</span>
      </span>
    </li>
  );
}

export function App() {
  const [api, setApi] = useState<Check>({
    label: "Same-origin API reachable",
    ok: null,
    detail: "probing /vendor/monaco/manifest.json …",
  });

  useEffect(() => {
    let live = true;
    fetch("/vendor/monaco/manifest.json", { cache: "no-store" })
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) {
          setApi({ label: "Same-origin API reachable", ok: false, detail: `HTTP ${r.status}` });
          return;
        }
        const j = await r.json();
        setApi({
          label: "Same-origin API reachable",
          ok: true,
          detail: `manifest OK — vsPath ${j.vsPath}`,
        });
      })
      .catch((e: unknown) => {
        if (!live) return;
        setApi({ label: "Same-origin API reachable", ok: false, detail: (e as Error).message });
      });
    return () => {
      live = false;
    };
  }, []);

  const checks: Check[] = [
    {
      label: "React renders + Tailwind compiled at build time",
      ok: true,
      detail: `${import.meta.env.MODE} build — styling is compiled CSS, not the Play CDN`,
    },
    checkEvalBlocked(),
    api,
  ];

  return (
    <main className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-xl rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">
            Qlerify<span className="text-amber-500">·</span>Live
          </span>
          <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-600 ring-1 ring-stone-200">
            React · Phase 0
          </span>
        </div>
        <p className="mt-1 text-sm text-stone-500">
          Toolchain proof for the frontend migration. Replaced by the real shell in Phase 1.
        </p>
        <ul className="mt-4">
          {checks.map((c) => (
            <Row key={c.label} check={c} />
          ))}
        </ul>
        <p className="mt-4 text-[11px] text-stone-400">
          Serving the legacy UI instead? Unset <span className="mono">QLERIFY_WEB_UI</span> and
          restart the server.
        </p>
      </div>
    </main>
  );
}
