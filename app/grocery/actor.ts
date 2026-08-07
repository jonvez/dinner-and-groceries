/**
 * Caller identity for the grocery Server Actions (issue #14). Mirrors
 * `app/recipes/new/actor.ts` (deliberately NOT a `"use server"` module — an
 * internal helper, not a directly-invocable endpoint): household + member are
 * resolved from the VERIFIED session, never from request input, so a caller can
 * never roll up into someone else's household. Fails closed (null) when the
 * session or membership can't be established.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type GroceryActor = { householdId: string; memberId: string };

export async function resolveGroceryActor(
  supabase: Pick<DbClient, "auth" | "rpc" | "from">,
): Promise<GroceryActor | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: householdId } = await supabase.rpc("current_household_id");
  if (!householdId) return null;

  const { data: member } = await supabase
    .from("members")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return null;

  return { householdId, memberId: member.id };
}
