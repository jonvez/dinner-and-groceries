/**
 * Caller identity for the recipe-ingest Server Actions (issue #12c). Mirrors
 * `app/board/actor.ts`'s `resolveActor` (deliberately NOT a `"use server"`
 * module — an internal helper, not a directly-invocable endpoint) but this flow
 * has no week concept, so it resolves only household + member id from the
 * VERIFIED session — never from request input. Fails closed (null) when the
 * session or membership can't be established; the middleware normally prevents
 * reaching here without both, but we don't assume it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export const GENERIC_ERROR = "Something went wrong. Reload and try again.";

export type RecipeActor = { householdId: string; memberId: string };

export async function resolveRecipeActor(
  supabase: Pick<DbClient, "auth" | "rpc" | "from">,
): Promise<RecipeActor | null> {
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
