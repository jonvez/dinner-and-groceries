/**
 * Next.js middleware entry. Runs on every matched request and delegates to
 * `updateSession`, which refreshes the `@supabase/ssr` cookie session and
 * applies the auth-boundary routing decision (gate protected routes, route a
 * member-less user to the join flow). See `lib/supabase/middleware.ts`.
 */

import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets and image-optimization
     * files. Auth-relevant routes (pages, the OAuth callback, sign-out) all
     * flow through, so the session is refreshed and gating is enforced.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
