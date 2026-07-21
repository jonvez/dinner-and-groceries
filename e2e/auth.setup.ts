import fs from "node:fs";

import { test as setup, expect } from "@playwright/test";

import { AUTH_DIR, STORAGE_STATE_A, STORAGE_STATE_B } from "./support/paths";
import { seedHousehold } from "./support/seed";

/**
 * Playwright "setup" project (runs before the authed suite via `dependencies`).
 *
 * Seeds two password users into ONE household against the local ephemeral
 * Supabase and persists each user's `@supabase/ssr` session as a `storageState`
 * file, so the authed tests start already-signed-in with NO Google OAuth. See
 * e2e/support/seed.ts for the security posture (no service-role; RLS throughout).
 */

// The well-known, non-secret local Supabase CLI defaults (match .env.example /
// playwright.config.ts). CI exports the running stack's values into the env; the
// defaults keep a local `npm run test:e2e` (with `npm run db:start`) working.
const LOCAL_URL = "http://127.0.0.1:54321";
const LOCAL_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

setup("seed two users in one household and persist their sessions", async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? LOCAL_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? LOCAL_ANON;

  // The cookie belongs to the APP origin (the standalone server Playwright boots
  // over plain http), so the domain is the app host and Secure must be off.
  const domain = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1").hostname;

  const { storageStateA, storageStateB, householdId } = await seedHousehold({
    url,
    anonKey,
    domain,
    secure: false,
  });

  expect(householdId).toBeTruthy();

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(STORAGE_STATE_A, JSON.stringify(storageStateA, null, 2));
  fs.writeFileSync(STORAGE_STATE_B, JSON.stringify(storageStateB, null, 2));
});
