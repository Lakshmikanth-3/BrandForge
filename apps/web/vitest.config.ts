import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const brandkitSource = fileURLToPath(
  new URL("../../packages/shared/src/brandkit.ts", import.meta.url),
);

// Separate config: the web tests need the React plugin and a DOM, which the
// node-side suites neither need nor should pay for.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@brandkit": brandkitSource } },
  test: {
    include: ["src/**/*.test.tsx"],
    environment: "jsdom",
    globals: false,
  },
});
