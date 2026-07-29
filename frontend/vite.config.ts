import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.VITE_API_TARGET ?? "http://localhost:3001";
const proxied = ["/api", "/v1", "/sim", "/org", "/chat", "/vendor"];

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      proxied.map((p) => [p, { target: API_TARGET, changeOrigin: true }]),
    ),
  },
});
