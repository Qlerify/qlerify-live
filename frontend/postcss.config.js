import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { fileURLToPath } from "node:url";

// Explicit config path: Tailwind otherwise searches from cwd, which is the repo root.
export default {
  plugins: [
    tailwindcss({ config: fileURLToPath(new URL("./tailwind.config.js", import.meta.url)) }),
    autoprefixer(),
  ],
};
