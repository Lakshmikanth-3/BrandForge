import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate config: the web tests need the React plugin and a DOM, which the
// node-side suites neither need nor should pay for.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.tsx"],
    environment: "jsdom",
    globals: false,
  },
});
