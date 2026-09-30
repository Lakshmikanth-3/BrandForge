import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The brand-kit generator lives in packages/shared and is the single source of
// truth: the API imports it (node) and the browser imports it here (bundled from
// TS source, no build step), so the free preview and the paid result never drift.
const brandkitSource = fileURLToPath(
  new URL("../../packages/shared/src/brandkit.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@brandkit": brandkitSource } },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // Dev proxies to the API so the frontend talks to one origin, exactly as it
    // does in production where a single Railway service owns the root domain.
    proxy: {
      "/api": { target: "http://127.0.0.1:4021", changeOrigin: true },
      "/v1": { target: "http://127.0.0.1:4021", changeOrigin: true },
      "/healthz": { target: "http://127.0.0.1:4021", changeOrigin: true },
    },
  },
});
