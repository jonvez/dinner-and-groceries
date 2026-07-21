/**
 * Resolve "who am I" for the home screen (issue #62).
 *
 * Deliberately NOT a `"use server"` module — an internal helper, not a Server
 * Action — so it can be unit-tested over an injected fake client, mirroring
 * `app/board/actor.ts`'s `resolveActor`.
 *
 * The `members_select` RLS policy lets ANY household member read ALL of their
 * co-members, so an unfiltered read returns an arbitrary row (the owner, who is
 * inserted first). We MUST scope to the VERIFIED signed-in user via
 * `auth.getUser()` + an explicit `user_id` filter; that filter — not RLS — is
 * what pins the lookup to the caller. Fails closed (returns null) when the
 * session or membership can't be established; the middleware normally prevents
 * reaching the home route without both, but we don't assume it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type CurrentMember = {
  displayName: string;
  isOwner: boolean;
};

export async function resolveCurrentMember(
  supabase: Pick<DbClient, "auth" | "from">,
): Promise<CurrentMember | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await supabase
    .from("members")
    .select("display_name, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return null;

  return {
    displayName: member.display_name,
    isOwner: member.role === "owner",
  };
}
