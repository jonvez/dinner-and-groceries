/**
 * Security configuration for the `@supabase/ssr` auth cookies (the access and
 * refresh tokens that constitute the session). Centralized + framework-free so
 * the policy is asserted once, in one place, and unit-tested.
 *
 * The defaults the security review will check:
 *   - **httpOnly**: the tokens are never exposed to client-side JavaScript,
 *     which blocks XSS-based token exfiltration.
 *   - **path "/"**: scoped to the whole app (the session applies everywhere).
 *   - **sameSite "lax"**: the cookie rides the *top-level* GET redirect coming
 *     back from Google's consent screen (so sign-in completes) but is withheld
 *     from cross-site sub-requests — a CSRF defense. ("strict" would drop the
 *     cookie on the OAuth return navigation and break sign-in.)
 *   - **secure** in production: HTTPS-only. Omitted in local dev so the cookie
 *     is accepted over `http://127.0.0.1`.
 */

import type { CookieOptions } from "@supabase/ssr";

type Flags = {
  /** True in deployed (HTTPS) environments; drives the Secure attribute. */
  isProduction: boolean;
};

type EnvSource = { NODE_ENV?: string };

export function authCookieOptions(
  flags?: Flags,
  env: EnvSource = process.env,
): CookieOptions {
  const isProduction = flags
    ? flags.isProduction
    : env.NODE_ENV === "production";

  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
  };
}
