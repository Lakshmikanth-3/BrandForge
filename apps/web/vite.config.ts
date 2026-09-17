import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
