/**
 * Server-side `@supabase/ssr` client wired to the Next.js request cookies
 * (the ssr cookie session). Use this from Server Components, Server Actions and
 * Route Handlers — it runs as the **signed-in user** (the cookie session's
 * access token), so RLS is always in force (ADR 0003, issue #5 criterion 4).
 * There is no service-role key on this path.
 *
 * Distinct from `lib/supabase/server.ts`'s `createUserClient(token)`, which is
 * for callers that already hold a bare access token. This helper is the
 * cookie-session entry point for the App Router.
 *
 * `cookies()` is read-only inside Server Components; writing throws. We swallow
 * that case because the **middleware** is responsible for refreshing and
 * persisting the session cookie (see `lib/supabase/middleware.ts`). Per the
 * @supabase/ssr guidance, a no-op `setAll` here is safe as long as middleware
 * runs on the route.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/database.types";

import { authCookieOptions } from "./cookie-options";
import { readSupabaseEnv, type SupabaseEnv } from "./env";

export async function createServerComponentClient(
  env: SupabaseEnv = readSupabaseEnv(),
) {
  const cookieStore = await cookies();
  const cookieSecurity = authCookieOptions();

  return createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, { ...options, ...cookieSecurity });
          });
        } catch {
          // Called from a Server Component where cookies are read-only.
          // Middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
    cookieOptions: cookieSecurity,
  });
}
