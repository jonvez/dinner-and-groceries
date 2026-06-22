import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { userScopedClientOptions } from "./client-options";
import { readSupabaseEnv, type SupabaseEnv } from "./env";

/**
 * Server-side Supabase client helper (stub).
 *
 * Per ADR 0003, all data access runs as the **signed-in user** so Row Level
 * Security is always in force — there is NO service-role usage in M0/M1. This
 * helper takes the user's access token explicitly and attaches it as a Bearer
 * header (see `userScopedClientOptions`). The full `@supabase/ssr` cookie +
 * middleware session wiring lands with the auth slice; this stub gives data
 * code a single, typed, RLS-correct entry point to build against now.
 *
 * @param accessToken the signed-in user's JWT. Required — passing a blank
 *   token throws rather than silently producing an unauthenticated client.
 * @param env injectable Supabase env (defaults to validated `process.env`).
 */
export function createUserClient(
  accessToken: string,
  env: SupabaseEnv = readSupabaseEnv(),
): SupabaseClient<Database> {
  const options = userScopedClientOptions(accessToken);

  return createClient<Database>(env.url, env.anonKey, options);
}

export type { Database };
