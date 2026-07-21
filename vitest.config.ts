import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.{test,spec}.{ts,tsx}"],
    // Playwright specs (`e2e/**/*.spec.ts`) use the Playwright runner, not
    // Vitest. But pure test-harness helpers under e2e/support carry `.test.ts`
    // and ARE unit-tested here (e.g. the storageState converter), so exclude
    // only the Playwright specs — not the whole e2e tree.
    exclude: ["node_modules", ".next", "e2e/**/*.spec.ts"],
  },
});
