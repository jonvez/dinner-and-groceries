/**
 * Resolve whether a signed-in auth user has a `members` row (i.e. belongs to a
 * household). This is the single fact that distinguishes the "no-member ->
 * join flow" boundary (issue #5) from a fully-onboarded user.
 *
 * The query runs through an RLS-scoped client (the caller's session). Note the
 * `members_select` policy lets a member read ALL co-members of their household,
 * NOT just their own row — so the explicit `user_id` filter (not RLS) is what
 * scopes this lookup to the caller. No service-role bypass.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function userHasMember(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("members")
    .select("id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error) {
    // Fail closed: if we cannot prove membership, treat the user as having
    // none (routes them to the join flow) rather than leaking into the app.
    return false;
  }

  return data !== null;
}
