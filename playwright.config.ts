import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the smoke E2E suite.
 *
 * The smoke test runs against `next start` (a production build) and does NOT
 * require Supabase, so it stays green today. CI builds the app, then starts it
 * via the `webServer` block below.
 *
 * TODO(#2): once supabase/ lands, CI spins up an ephemeral local Supabase DB
 * (guarded on supabase/config.toml in .github/workflows/ci.yml) and env vars
 * (NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY) get injected here for data-backed E2E.
 */
const PORT = Number(process.env.PORT ?? 3000);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Production build must already exist (`npm run build`). CI builds first,
    // then Playwright boots the standalone server — the exact artifact the
    // Cloud Run Docker image ships. Locally, reuse a running server.
    command: "npm run start:standalone",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
