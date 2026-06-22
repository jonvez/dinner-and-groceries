import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the smoke E2E suite.
 *
 * The smoke test runs against `next start` (a production build). The Next.js
 * middleware constructs an @supabase/ssr client on every request, so the public
 * Supabase env vars must be present — but the signed-out smoke path never
 * contacts Supabase (an anonymous request has no session token, so getUser()
 * resolves to "no user" without a network call). The well-known local CLI
 * defaults below are therefore sufficient and need no live Google/Supabase
 * backend, keeping this required check green with zero real credentials.
 *
 * TODO(#2): once data-backed E2E flows are wanted, CI can override these with
 * an ephemeral local Supabase DB's values (guarded on supabase/config.toml).
 */
const PORT = Number(process.env.PORT ?? 3000);
const baseURL = `http://127.0.0.1:${PORT}`;

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known, non-secret local Supabase CLI anon key (matches .env.example).
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

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
    env: {
      PORT: String(PORT),
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    },
  },
});
