// Supply-chain guard: dependency install scripts must be explicitly allowlisted.
//
// npm ≥ 11.16 gates dependency install scripts on the `allowScripts` field in
// package.json (warn today, hard block in npm 12). We pin approvals to exact
// versions so a compromised future release of a dependency can't run an
// unreviewed postinstall. This test enforces the same contract on EVERY npm
// version (the Mac dev machines run npm 10, which ignores the field), using
// package-lock.json's `hasInstallScript` markers as the platform-independent
// source of truth — it covers optional deps for platforms we don't develop on.
//
// Proves:
//   - every package in the locked tree that runs an install script has an
//     explicit `true` entry in allowScripts (pinned name@version, or bare name)
//   - no stale entries: every allowScripts key still matches a script-running
//     package in the lockfile (catches forgotten pins after a dependency bump)
//
// When this fails after a dependency bump: re-approve the new versions with
// `npm approve-scripts` (npm ≥ 11.16) or update the pins in package.json by hand.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function readJson(rel: string): any {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
}

const allowScripts: Record<string, boolean> =
  readJson("../../package.json").allowScripts ?? {};
const lock = readJson("../../package-lock.json");

// name@version of every package in the locked tree that runs an install script
const scriptRunners: { name: string; version: string }[] = Object.entries(
  lock.packages as Record<string, any>,
)
  .filter(([path, meta]) => path !== "" && meta.hasInstallScript)
  .map(([path, meta]) => ({
    name: path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
    version: meta.version as string,
  }));

// "@prisma/client@5.22.0" -> { name: "@prisma/client", version: "5.22.0" }
function parseEntry(key: string): { name: string; version: string | null } {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key, version: null }; // bare name (or lone scope-@)
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

describe("install-script allowlist (package.json allowScripts)", () => {
  it("has at least the known script-running packages in the tree", () => {
    // Sanity: if the lockfile format ever stops carrying hasInstallScript,
    // this test would silently pass on an empty set — fail loudly instead.
    expect(scriptRunners.length).toBeGreaterThan(0);
  });

  it("approves every package in the lockfile that runs an install script", () => {
    const uncovered = scriptRunners
      .filter(
        ({ name, version }) =>
          allowScripts[`${name}@${version}`] !== true && allowScripts[name] !== true,
      )
      .map(({ name, version }) => `${name}@${version}`);
    expect(
      uncovered,
      `Packages with install scripts not approved in package.json "allowScripts": ` +
        `${uncovered.join(", ")}. Review the script, then add a pinned entry ` +
        `("<name>@<version>": true) or run \`npm approve-scripts\` on npm ≥ 11.16. ` +
        `npm 12 will refuse to run unapproved install scripts (breaking Prisma ` +
        `client generation and the esbuild binary on fresh installs).`,
    ).toEqual([]);
  });

  it("has no stale entries left over from old dependency versions", () => {
    const stale = Object.keys(allowScripts).filter((key) => {
      const { name, version } = parseEntry(key);
      return !scriptRunners.some(
        (p) => p.name === name && (version === null || p.version === version),
      );
    });
    expect(
      stale,
      `allowScripts entries that no longer match any script-running package in ` +
        `package-lock.json: ${stale.join(", ")}. Remove them (or re-pin to the ` +
        `new version after a dependency bump).`,
    ).toEqual([]);
  });
});
