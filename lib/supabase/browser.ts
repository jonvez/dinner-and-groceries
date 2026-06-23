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
  // Read the public env vars as *static* `process.env.NEXT_PUBLIC_*` member
  // expressions so Next.js inlines them into the client bundle at build time.
  // Passing them explicitly (rather than letting readSupabaseEnv default to the
  // aliased `process.env`) is required — a dynamic `source.NEXT_PUBLIC_X` access
  // is NOT statically replaced, so it would be undefined in the browser.
  const env = readSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  return createBrowserClient<Database>(env.url, env.anonKey);
}
