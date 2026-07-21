/**
 * Seed an authenticated E2E fixture: two password users in ONE household, with
 * each user's `@supabase/ssr` session captured as a Playwright `storageState`.
 *
 * Why this exists (issue #56): the smoke suite only exercises the SIGNED-OUT
 * path (`/` -> `/login`). The authed loop — RLS-scoped SSR, the board, Realtime —
 * is where the real regressions hide (#62, #63). We do NOT drive Google OAuth:
 * once a session exists, every authenticated path is identical regardless of the
 * provider that minted it. So we mint sessions directly against the local
 * (ephemeral, CI-only) Supabase, which permits email/password.
 *
 * Security posture (ADR 0003 stays intact): there is ZERO service-role key here.
 * Local Supabase has email confirmations disabled (supabase/config.toml
 * `enable_confirmations = false`), so `auth.signUp` returns a live session
 * immediately — no admin/service-role user creation needed. The household is
 * built entirely through the app's OWN authenticated RPCs (`create_household`,
 * the owner-only invite INSERT, `accept_invite`) exactly as a real user would,
 * so the seed is realistic AND runs fully under RLS as the signed-in users.
 */

import { createServerClient } from "@supabase/ssr";
import { randomUUID } from "node:crypto";

import {
  acceptInvite,
  createHousehold,
  generateInvite,
} from "@/app/join/actions-core";
import type { Database } from "@/lib/database.types";

import {
  sessionCookiesToStorageState,
  type StorageState,
} from "./storage-state";

/** Session lifetime for the captured cookie (well beyond any E2E run). */
const COOKIE_TTL_SEC = 60 * 60 * 24;

export type SeedOptions = {
  /** Local Supabase API URL (e.g. http://127.0.0.1:54321). */
  url: string;
  /** Local Supabase anon key (RLS-protected; browser-safe). */
  anonKey: string;
  /** Cookie domain for the storageState (the APP host, e.g. 127.0.0.1). */
  domain: string;
  /** Secure flag — false for the local http standalone server. */
  secure: boolean;
};

export type SeededHousehold = {
  householdId: string;
  storageStateA: StorageState;
  storageStateB: StorageState;
};

/** Build an `@supabase/ssr` server client backed by an in-memory cookie jar. */
function createJarClient(url: string, anonKey: string) {
  const store = new Map<string, string>();
  const client = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return [...store.entries()].map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          if (value === "") store.delete(name);
          else store.set(name, value);
        }
      },
    },
  });
  return { client, store };
}

function snapshot(store: Map<string, string>) {
  return [...store.entries()].map(([name, value]) => ({ name, value }));
}

async function signUp(
  client: ReturnType<typeof createJarClient>["client"],
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.user) {
    throw new Error(`seed: signUp(${email}) failed: ${error?.message ?? "no user"}`);
  }
  return data.user.id;
}

export async function seedHousehold(opts: SeedOptions): Promise<SeededHousehold> {
  const suffix = randomUUID().slice(0, 12);
  const password = `E2e-${randomUUID()}`;

  // --- Owner (user A): sign up, create the household, mint an invite ---------
  const a = createJarClient(opts.url, opts.anonKey);
  const aUserId = await signUp(a.client, `e2e-a-${suffix}@example.test`, password);

  const created = await createHousehold(a.client, {
    name: `E2E Household ${suffix}`,
    displayName: "Alex (E2E)",
  });
  if (!created.ok) throw new Error(`seed: create_household failed: ${created.error}`);

  const invite = await generateInvite(a.client, {
    householdId: created.householdId,
    createdBy: aUserId, // invites.created_by references auth.users(id)
  });
  if (!invite.ok) throw new Error(`seed: generateInvite failed: ${invite.error}`);

  // --- Member (user B): sign up, accept the invite into the SAME household ----
  const b = createJarClient(opts.url, opts.anonKey);
  await signUp(b.client, `e2e-b-${suffix}@example.test`, password);

  const joined = await acceptInvite(b.client, {
    token: invite.token,
    displayName: "Bailey (E2E)",
  });
  if (!joined.ok) throw new Error(`seed: acceptInvite failed: ${joined.error}`);
  if (joined.householdId !== created.householdId) {
    throw new Error("seed: user B joined a different household than expected");
  }

  const expiresUnixSec = Math.floor(Date.now() / 1000) + COOKIE_TTL_SEC;
  const toState = (store: Map<string, string>): StorageState =>
    sessionCookiesToStorageState(snapshot(store), {
      domain: opts.domain,
      secure: opts.secure,
      expiresUnixSec,
    });

  return {
    householdId: created.householdId,
    storageStateA: toState(a.store),
    storageStateB: toState(b.store),
  };
}
