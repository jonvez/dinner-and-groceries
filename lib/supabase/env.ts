/**
 * Reads and validates the Supabase environment variables required by the
 * client helpers. Kept separate (and framework-free) so it can be unit-tested
 * and reused by both server and edge contexts.
 *
 * Only the public URL + anon (publishable) key are read here. There is
 * deliberately NO service-role key access in M0/M1 (ADR 0003): all data access
 * runs as the signed-in user so RLS is always in force.
 */

export type SupabaseEnv = {
  url: string;
  anonKey: string;
};

type EnvSource = Record<string, string | undefined>;

/**
 * Validate and return the Supabase public env vars.
 *
 * @param source defaults to `process.env`; injectable for tests.
 * @throws with an actionable message listing every missing var.
 */
export function readSupabaseEnv(source: EnvSource = process.env): SupabaseEnv {
  const url = source.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = source.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing: string[] = [];
  if (!url || url.trim() === "") missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey || anonKey.trim() === "")
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required Supabase env var(s): ${missing.join(", ")}. ` +
        "See .env.example and run `npm run db:env` to print local values.",
    );
  }

  return { url: url!, anonKey: anonKey! };
}
