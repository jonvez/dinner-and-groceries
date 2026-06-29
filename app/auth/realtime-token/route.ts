/**
 * Realtime access-token endpoint (issue #44 — fixes live collaboration).
 *
 * The browser Realtime socket authenticates with the anon key only (session
 * tokens are httpOnly, unreadable from JS), so RLS-gated `postgres_changes` on
 * reactions/comments deliver nothing. This same-origin route reads the httpOnly
 * cookie session SERVER-side and returns the user's **short-lived access token**
 * so the client can `realtime.setAuth(token)`. See `lib/supabase/realtime-auth.ts`
 * and ADR 0008.
 *
 * Security:
 *   - Returns ONLY the short-lived access token + its expiry. The refresh token
 *     never leaves the httpOnly cookie (RLS-always-in-force is preserved; no
 *     service-role key anywhere near the browser).
 *   - Identity is verified with `auth.getUser()` and fails closed (401) for any
 *     caller without a real session.
 *   - `Cache-Control: no-store` so the token is never cached by the browser or
 *     an intermediary.
 */

import { NextResponse } from "next/server";

import { createServerComponentClient } from "@/lib/supabase/server-component";

import { resolveRealtimeToken } from "./route-core";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const supabase = await createServerComponentClient();
  const result = await resolveRealtimeToken(supabase);

  if (!result.ok) {
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    { token: result.token, expiresAt: result.expiresAt },
    { headers: NO_STORE },
  );
}
