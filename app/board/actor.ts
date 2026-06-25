/**
 * Caller/identity + week resolution for the board's Server Actions (issue #8).
 *
 * Deliberately NOT a `"use server"` module: these are internal helpers, not
 * Server Actions, so they must not be exposed as directly-invocable endpoints.
 * Keeping them here (like the join flow's `actions-core`) also lets them be
 * unit-tested over an injected fake client — which is exactly the untrusted-
 * input boundary worth covering: no-session / no-membership, and a crafted
 * `?week=` value being rejected or re-normalized before any write.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { isValidIsoDate, weekStartForDate } from "@/lib/week/boundary";

import { getOrCreateWeek } from "./actions-core";

type DbClient = SupabaseClient<Database>;

export const GENERIC_ERROR = "Something went wrong. Reload and try again.";

export type Actor = {
  householdId: string;
  memberId: string;
  weekStartDay: number;
};

/**
 * Resolve the signed-in member's household + member id + week-start preference
 * from the VERIFIED session (`auth.getUser()`) and the SECURITY DEFINER
 * household helper — never from request input. Returns null if the session or
 * household membership can't be established (the middleware normally prevents
 * reaching here without a membership, but we fail closed regardless).
 */
export async function resolveActor(
  supabase: Pick<DbClient, "auth" | "rpc" | "from">,
): Promise<Actor | null> {
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

  const { data: household } = await supabase
    .from("households")
    .select("week_start_day")
    .maybeSingle();

  return {
    householdId,
    memberId: member.id,
    weekStartDay: household?.week_start_day ?? 1,
  };
}

/**
 * Validate the untrusted `rawWeekStart`, re-normalize it to the household's
 * canonical week boundary (so a crafted off-grid date can't create a stray
 * week), then lazily open the week. RLS still scopes the write to the household.
 */
export async function resolveWeekId(
  supabase: Pick<DbClient, "from">,
  actor: Actor,
  rawWeekStart: string,
): Promise<{ weekId: string } | { error: string }> {
  if (!isValidIsoDate(rawWeekStart)) return { error: GENERIC_ERROR };
  const startDate = weekStartForDate(rawWeekStart, actor.weekStartDay);

  const week = await getOrCreateWeek(supabase, {
    householdId: actor.householdId,
    startDate,
  });
  if (!week.ok) return { error: week.error };
  return { weekId: week.weekId };
}
