"use server";

/**
 * Server Actions for the join flow (issue #6). These are the thin Next.js
 * boundary: build the RLS-scoped cookie-session client (runs as the signed-in
 * user — no service-role key), delegate to the pure `actions-core` logic, then
 * redirect on success or return a field error for the form to render.
 *
 * Security:
 *   - The signed-in user is resolved via `auth.getUser()` (verified JWT), never
 *     trusted from form input — `created_by`/owner/member identity all derive
 *     from `auth.uid()` server-side (in the SECURITY DEFINER functions and here).
 *   - `revalidatePath("/")` after a state change so the middleware/home re-reads
 *     fresh membership rather than a stale "no household" view.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requestOrigin } from "@/lib/http/request-origin";
import { createServerComponentClient } from "@/lib/supabase/server-component";

import {
  acceptInvite,
  createHousehold,
  generateInvite,
} from "./actions-core";

export type FormState = { error: string } | null;

const NOT_SIGNED_IN = "Your session expired. Please sign in again.";

export async function createHouseholdAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const supabase = await createServerComponentClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NOT_SIGNED_IN };

  const result = await createHousehold(supabase, {
    name: String(formData.get("name") ?? ""),
    displayName: String(formData.get("displayName") ?? ""),
  });

  if (!result.ok) return { error: result.error };

  revalidatePath("/");
  redirect("/");
}

export async function acceptInviteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const supabase = await createServerComponentClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NOT_SIGNED_IN };

  const result = await acceptInvite(supabase, {
    token: String(formData.get("token") ?? ""),
    displayName: String(formData.get("displayName") ?? ""),
  });

  if (!result.ok) return { error: result.error };

  revalidatePath("/");
  redirect("/");
}

/**
 * Owner-only: mint an invite for the caller's household. Returns the share URL
 * (built from the *request* origin, never a client-supplied host) or an error.
 */
export type InviteState =
  | { url: string; expiresAt: string | null }
  | { error: string }
  | null;

export async function generateInviteAction(
  prevState: InviteState,
  formData: FormData,
): Promise<InviteState> {
  // useActionState supplies (prevState, formData); this action needs neither —
  // it mints fresh each invocation. Referenced to keep the signature lint-clean.
  void prevState;
  void formData;

  const { headers } = await import("next/headers");

  const supabase = await createServerComponentClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NOT_SIGNED_IN };

  // The caller's household (SECURITY DEFINER helper; null if none).
  const { data: householdId } = await supabase.rpc("current_household_id");
  if (!householdId) {
    return { error: "Create or join a household before inviting." };
  }

  const result = await generateInvite(supabase, {
    householdId,
    createdBy: user.id,
  });
  if (!result.ok) return { error: result.error };

  // Build the absolute link from the trusted proxy-forwarded request origin.
  const { inviteUrl } = await import("@/lib/invites/url");
  const origin = requestOrigin(await headers());

  return { url: inviteUrl(result.token, origin), expiresAt: result.expiresAt };
}
