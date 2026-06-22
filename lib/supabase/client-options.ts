/**
 * Framework-free helpers for constructing the options bag passed to
 * `createClient` from `@supabase/supabase-js`.
 *
 * The single most important invariant (per ADR 0003) is that server-side
 * data access runs as the **signed-in user**, never the service role, so
 * Row Level Security is always in force. We enforce that by attaching the
 * user's access token as a per-request `Authorization: Bearer <token>`
 * header. These helpers are pure so they can be unit-tested in isolation,
 * away from the network client itself.
 */

export type SupabaseClientOptions = {
  global: { headers: Record<string, string> };
  auth: {
    persistSession: boolean;
    autoRefreshToken: boolean;
    detectSessionInUrl: boolean;
  };
};

/**
 * Build the options bag for a server-side, user-scoped Supabase client.
 *
 * @param accessToken the signed-in user's JWT access token. Passing it as a
 *   Bearer header makes every request run with that user's RLS context.
 * @throws if `accessToken` is missing/blank — we never silently fall back to
 *   an unauthenticated (or, worse, elevated) client.
 */
export function userScopedClientOptions(
  accessToken: string,
): SupabaseClientOptions {
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    throw new Error(
      "userScopedClientOptions: a non-empty user access token is required " +
        "(RLS must always be in force; no service-role fallback).",
    );
  }

  return {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    // Server clients are request-scoped and stateless: the token is supplied
    // per call, so the client must not persist or auto-refresh sessions.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  };
}
