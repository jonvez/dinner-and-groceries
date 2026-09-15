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
 *
 * Cookie propagation (the local-auth blocker, bug A): on a successful exchange
 * the SSR client emits the session cookies through `setAll`. Those cookies MUST
 * land on the SAME response object we return, or the browser never receives
 * them and the next request is bounced to /login. We therefore build the
 * success redirect response FIRST and have `setAll` write onto it — never onto
 * the `next/headers` store (whose writes do not propagate to a freshly
 * constructed `NextResponse.redirect()`).
 *
 * Analytics (issue #210): a successful exchange emits `sign_in` — see
 * `emitSignIn` below for why it can be skipped, and why it can never break the
 * sign-in.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { emitEvent } from "@/lib/analytics/events";
import { safeRedirectPath } from "@/lib/auth/redirect";
import { requestOrigin } from "@/lib/http/request-origin";
import { authCookieOptions } from "@/lib/supabase/cookie-options";
import { readSupabaseEnv } from "@/lib/supabase/env";

/**
 * Emit `sign_in` for a just-authenticated user (ADR 0014).
 *
 * Two constraints shape this:
 *   1. `events.household_id` is NOT NULL and `events_insert` checks it against
 *      `public.current_household_id()`, so a FIRST-TIME user — who has no
 *      household until they create or join one — has nothing to attribute the
 *      event to. Resolve the household and emit only when it is non-null; skip
 *      silently otherwise (never a placeholder household).
 *   2. Analytics must never fail or slow down a sign-in. The household RPC and
 *      the member lookup are issued in PARALLEL (one extra round-trip, not
 *      two), and the whole block is wrapped so nothing here — not even a thrown
 *      transport error — can change the redirect the caller gets.
 *
 * `member_id` is the pseudonymous app member, resolved from the VERIFIED user id
 * the exchange returned (never from the request). No Google identity is touched.
 */
async function emitSignIn(
  supabase: SupabaseClient<Database>,
  userId: string | null | undefined,
): Promise<void> {
  try {
    const [household, member] = await Promise.all([
      supabase.rpc("current_household_id"),
      userId
        ? supabase.from("members").select("id").eq("user_id", userId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const householdId = household.data;
    if (!householdId) return;

    await emitEvent(supabase, {
      householdId,
      memberId: member.data?.id ?? null,
      eventType: "sign_in",
    });
  } catch {
    // Never let analytics touch the sign-in.
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  // Behind Cloud Run, request.nextUrl.origin is the container's internal bind
  // host (0.0.0.0:8080); use the proxy-forwarded public origin for redirects.
  const origin = requestOrigin(request.headers, request.nextUrl.origin);
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"));

  // OAuth provider errors (e.g. user denied consent) come back as `error`.
  const oauthError = searchParams.get("error");
  if (oauthError || !code) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  const env = readSupabaseEnv();
  const cookieSecurity = authCookieOptions();

  // The response we hand back on success. `setAll` writes the session cookies
  // directly onto THIS object so they reach the browser as Set-Cookie headers.
  // `next` is already validated to be a same-origin relative path.
  const response = NextResponse.redirect(`${origin}${next}`);

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

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  await emitSignIn(supabase, data?.user?.id);

  return response;
}
