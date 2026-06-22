/**
 * Next.js middleware session handler (issue #5 — acceptance criteria 2 & 5).
 *
 * On every matched request this:
 *   1. Builds an `@supabase/ssr` server client bound to the request/response
 *      cookies, so a token refresh is written back to the response (this is
 *      what keeps the user signed in across reloads/navigation — criterion 2).
 *   2. Calls `auth.getUser()` — the *verified* identity (it validates the JWT
 *      with the Auth server), never `getSession()` (which trusts unverified
 *      cookie contents). Authorization decisions must use a verified user.
 *   3. Looks up household membership (only when signed in) and applies the
 *      pure `resolveAuthRoute` decision: gate protected routes, route a
 *      member-less user to the join flow (criterion 5).
 *
 * All data access uses the anon key + the user's cookie session => RLS is in
 * force (criterion 4). There is no service-role key on this path.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";

import { resolveAuthRoute } from "@/lib/auth/routing";
import { authCookieOptions } from "./cookie-options";
import { readSupabaseEnv, type SupabaseEnv } from "./env";
import { userHasMember } from "./membership";

export async function updateSession(
  request: NextRequest,
  env: SupabaseEnv = readSupabaseEnv(),
): Promise<NextResponse> {
  // The response we hand back. The ssr client writes refreshed-session cookies
  // onto BOTH the forwarded request (so downstream sees them) and this
  // response (so the browser stores them).
  let response = NextResponse.next({ request });

  const cookieSecurity = authCookieOptions();

  const supabase = createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, {
            ...options,
            ...cookieSecurity,
          });
        });
      },
    },
    cookieOptions: cookieSecurity,
  });

  // IMPORTANT: getUser() (verified), called before generating the response, so
  // any refreshed token is captured by setAll above.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthenticated = user !== null;
  // Only resolve membership when there is a user — avoids a needless query for
  // signed-out visitors (and there is nothing to look up).
  const hasMember = isAuthenticated
    ? await userHasMember(supabase, user.id)
    : false;

  const decision = resolveAuthRoute({
    isAuthenticated,
    hasMember,
    pathname: request.nextUrl.pathname,
    next: request.nextUrl.searchParams.get("next"),
  });

  if (decision.action === "redirect") {
    const url = request.nextUrl.clone();
    const [pathname, query = ""] = decision.to.split("?", 2);
    url.pathname = pathname;
    url.search = query;
    // Carry forward any refreshed-session cookies onto the redirect response.
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((cookie) => {
      redirect.cookies.set(cookie);
    });
    return redirect;
  }

  return response;
}
