import { fileURLToPath } from "node:url"

// Absolute, because the build runs from the repo root — cwd-relative globs would
// match nothing here and emit CSS with no utility classes.
const dir = fileURLToPath(new URL(".", import.meta.url))

/** v3 on purpose: matches what the Play CDN served, so the ported UI looks identical.
 * @type {import('tailwindcss').Config} */
export default {
  content: [`${dir}index.html`, `${dir}src/**/*.{ts,tsx}`],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
}
