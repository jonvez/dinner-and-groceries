import path from "node:path";

/**
 * Where the seeded `@supabase/ssr` session `storageState` files land. Written by
 * `e2e/auth.setup.ts` (the Playwright "setup" project) and consumed by the authed
 * projects + the two-context Realtime test. Gitignored — they hold live (local,
 * throwaway) session tokens and are re-seeded on every run.
 */
export const AUTH_DIR = path.join(process.cwd(), "e2e", ".auth");

/** Household owner (creates the household, proposes, reacts). */
export const STORAGE_STATE_A = path.join(AUTH_DIR, "user-a.json");

/** Second member of the SAME household (joins via invite; the Realtime observer). */
export const STORAGE_STATE_B = path.join(AUTH_DIR, "user-b.json");

/**
 * Names the seed minted that a spec has to know about — currently the grocery
 * item stranded in a past week. Written by the setup project beside the session
 * files, and gitignored with them.
 */
export const SEED_FIXTURE = path.join(AUTH_DIR, "fixture.json");
