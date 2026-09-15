"use server";

/**
 * The `session_start` Server Action (issue #210) — the one analytics event with
 * no user action behind it, so it needs its own endpoint.
 *
 * Why it exists (ADR 0014): sessions are long-lived, so `sign_in` alone
 * under-counts daily use to the point where the PO dashboard's adoption panel
 * would look empty. `components/session-beacon.tsx` calls this ONCE per browser
 * session (guarded by `sessionStorage`) from the authenticated app shell.
 * `screen_view` is deliberately NOT emitted — this must never become a
 * per-navigation event (see `lib/analytics/events.ts`).
 *
 * Security: a Server Action is a PUBLIC endpoint, so this takes NO input at all
 * — household and member are resolved from the VERIFIED session
 * (`auth.getUser()` + the SECURITY DEFINER household helper + an explicit
 * `user_id` filter, the #62 lesson), never from the request. It fails closed and
 * reports `{ ok: false }` so the caller can leave its guard unset and try again
 * later (e.g. once a brand-new user has joined a household); the payload is `{}`
 * and attribution is the pseudonymous `member_id` only.
 */

import { emitEvent } from "@/lib/analytics/events";
import { createServerComponentClient } from "@/lib/supabase/server-component";

export type SessionStartResult = { ok: boolean };

export async function recordSessionStartAction(): Promise<SessionStartResult> {
  try {
    const supabase = await createServerComponentClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false };

    const { data: householdId } = await supabase.rpc("current_household_id");
    // `events.household_id` is NOT NULL and the INSERT policy checks it, so a
    // user who has not created/joined a household yet cannot emit.
    if (!householdId) return { ok: false };

    const { data: member } = await supabase
      .from("members")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) return { ok: false };

    const result = await emitEvent(supabase, {
      householdId,
      memberId: member.id,
      eventType: "session_start",
    });

    return { ok: result.ok };
  } catch {
    // Analytics never surfaces an error — not even to its own caller.
    return { ok: false };
  }
}
