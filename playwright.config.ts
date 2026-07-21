import { defineConfig, devices } from "@playwright/test";

import { STORAGE_STATE_A } from "./e2e/support/paths";

/**
 * Playwright config for the E2E suite.
 *
 * Two tiers, run against the production standalone build (`start:standalone` —
 * the exact artifact the Cloud Run image ships):
 *
 *   - **smoke** (no session): the signed-out path (`/` -> `/login`). An
 *     anonymous request carries no session token, so the middleware's getUser()
 *     resolves to "no user" without a network call — this tier needs no live
 *     backend and stays green with just the well-known local defaults below.
 *
 *   - **authed** (issue #56): the AUTHENTICATED loop — authed SSR + RLS render,
 *     propose/react/comment, and the two-context live Realtime guard. The
 *     `setup` project seeds two users in one household against the local
 *     ephemeral Supabase and writes each session as a `storageState` (see
 *     e2e/auth.setup.ts); the authed projects depend on it. This tier needs a
 *     live local Supabase (CI boots one; locally run `npm run db:start`).
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
    // Seeds two users in one household and writes their storageState files. The
    // authed projects depend on it; it runs first. Its NODE process reads
    // NEXT_PUBLIC_SUPABASE_* from the ambient env (CI exports the running local
    // stack's values; local defaults otherwise).
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
    },
    // Signed-out smoke — no session, no Supabase dependency.
    {
      name: "smoke",
      testMatch: /smoke\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Authenticated flows. Project-level storageState signs every test in as
    // user A; the Realtime spec opens its own second context as user B.
    {
      name: "authed",
      testMatch: /authed\/.*\.spec\.ts$/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE_A },
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
