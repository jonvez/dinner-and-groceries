/**
 * Pure core for the Realtime token endpoint (issue #44).
 *
 * Deliberately NOT a route handler itself: keeping the verify-then-read logic
 * here (like the board's `actor.ts`) lets it be unit-tested over an injected
 * fake client, which is the security-critical boundary worth covering — it must
 * fail closed for any caller without a verified session, and it must hand back
 * ONLY the short-lived access token, never the refresh token.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type RealtimeTokenResult =
  | { ok: true; token: string; expiresAt: number | null }
  | { ok: false };

/**
 * Resolve the signed-in user's short-lived access token from the cookie
 * session. We verify identity with `auth.getUser()` (validates the JWT against
 * the Auth server) before trusting the session, then read the access token from
 * `auth.getSession()`. Fails closed if either the user or the access token is
 * absent.
 */
export async function resolveRealtimeToken(
  supabase: Pick<SupabaseClient, "auth">,
): Promise<RealtimeTokenResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (typeof token !== "string" || token === "") return { ok: false };

  // ONLY the access token + its expiry leave this function. The refresh token
  // stays in the httpOnly cookie and is never read or returned here.
  return { ok: true, token, expiresAt: session?.expires_at ?? null };
}
