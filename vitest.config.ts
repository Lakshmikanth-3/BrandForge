import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["packages/*/src/**"] },
  },
});
