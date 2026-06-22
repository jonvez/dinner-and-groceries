/**
 * Google OAuth callback (issue #5, criterion 1).
 *
 * Google redirects here with an authorization `code` (PKCE flow). We exchange
 * it for a session via `@supabase/ssr`, which writes the httpOnly session
 * cookies, then send the user on to their intended destination.
 *
 * Security:
 *   - The `next` parameter is attacker-controllable, so it is validated through
 *     `safeRedirectPath` (same-origin path only) to prevent an open redirect.
 *   - We redirect to a relative path on the *request* origin; we never trust a
 *     host from the query string.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/database.types";

import { safeRedirectPath } from "@/lib/auth/redirect";
import { authCookieOptions } from "@/lib/supabase/cookie-options";
import { readSupabaseEnv } from "@/lib/supabase/env";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"));

  // OAuth provider errors (e.g. user denied consent) come back as `error`.
  const oauthError = searchParams.get("error");
  if (oauthError || !code) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  // `next` is already validated to be a same-origin relative path.
  return NextResponse.redirect(`${origin}${next}`);
}
