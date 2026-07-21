/**
 * Convert a seeded `@supabase/ssr` session (captured as raw name/value cookies
 * from an in-memory jar) into the Playwright `storageState` shape, so authed E2E
 * tests can start already-signed-in without any Google OAuth round-trip.
 *
 * The flags below mirror the app's real auth-cookie policy
 * (`lib/supabase/cookie-options.ts`): httpOnly + sameSite=Lax, and Secure only
 * on HTTPS. That makes the seeded session behave exactly like a Google-minted
 * one — the middleware's `getUser()` verifies the JWT regardless of how the
 * cookie was written.
 */

export type CapturedCookie = { name: string; value: string };

export type StorageStateCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

export type StorageState = {
  cookies: StorageStateCookie[];
  origins: [];
};

export function sessionCookiesToStorageState(
  cookies: CapturedCookie[],
  opts: { domain: string; secure: boolean; expiresUnixSec: number },
): StorageState {
  return {
    cookies: cookies.map(({ name, value }) => ({
      name,
      value,
      domain: opts.domain,
      path: "/",
      expires: opts.expiresUnixSec,
      httpOnly: true,
      secure: opts.secure,
      sameSite: "Lax",
    })),
    origins: [],
  };
}
