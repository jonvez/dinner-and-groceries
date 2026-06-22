/**
 * Sign-out (issue #5, criterion 3). A POST clears the `@supabase/ssr` session
 * cookies via `auth.signOut()`, then redirects to /login. Protected routes are
 * then re-gated by the middleware on the next navigation.
 *
 * POST-only (not GET) so a sign-out cannot be triggered by a cross-site image/
 * link prefetch (CSRF hygiene for a state-changing action).
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/database.types";

import { authCookieOptions } from "@/lib/supabase/cookie-options";
import { readSupabaseEnv } from "@/lib/supabase/env";

export async function POST(request: NextRequest) {
  const { origin } = request.nextUrl;
  const env = readSupabaseEnv();
  const cookieStore = await cookies();
  const cookieSecurity = authCookieOptions();

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, { ...options, ...cookieSecurity });
        });
      },
    },
    cookieOptions: cookieSecurity,
  });

  await supabase.auth.signOut();

  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}
