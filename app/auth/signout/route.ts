/**
 * Sign-out (issue #5, criterion 3). A POST clears the `@supabase/ssr` session
 * cookies via `auth.signOut()`, then redirects to /login. Protected routes are
 * then re-gated by the middleware on the next navigation.
 *
 * POST-only (not GET) so a sign-out cannot be triggered by a cross-site image/
 * link prefetch (CSRF hygiene for a state-changing action).
 *
 * Cookie propagation (bug A): `signOut()` clears the session by emitting empty
 * cookies through `setAll`. Those writes must land on the SAME redirect
 * response we return, or the browser keeps the stale session. We build the
 * response first and have `setAll` write onto it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";

import { authCookieOptions } from "@/lib/supabase/cookie-options";
import { readSupabaseEnv } from "@/lib/supabase/env";

export async function POST(request: NextRequest) {
  const { origin } = request.nextUrl;
  const env = readSupabaseEnv();
  const cookieSecurity = authCookieOptions();

  // Build the response first so the cleared session cookies ride on it.
  const response = NextResponse.redirect(`${origin}/login`, { status: 303 });

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, { ...options, ...cookieSecurity });
        });
      },
    },
    cookieOptions: cookieSecurity,
  });

  await supabase.auth.signOut();

  return response;
}
