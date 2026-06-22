/**
 * Browser-side `@supabase/ssr` client. Used only by the sign-in UI to kick off
 * the Google OAuth redirect (`auth.signInWithOAuth`). It uses the public URL +
 * anon key (RLS-protected, browser-safe) — never a service-role key, and the
 * httpOnly session cookies are written by `@supabase/ssr`, so the access/refresh
 * tokens are never readable from this client-side bundle.
 */

"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";

import { readSupabaseEnv } from "./env";

export function createClient() {
  const env = readSupabaseEnv();
  return createBrowserClient<Database>(env.url, env.anonKey);
}
