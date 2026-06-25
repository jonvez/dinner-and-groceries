"use server";

/**
 * Server Actions for the week board (issue #8) — the thin Next.js boundary.
 * Build the RLS-scoped cookie-session client (runs as the signed-in user; no
 * service-role key), resolve the caller's household + member identity from the
 * VERIFIED session (never trusted from form input), delegate to the pure
 * `actions-core` writes, then revalidate the board.
 *
 * The submitted `weekStart` is treated as untrusted: it is validated as a real
 * date and re-normalized to the household's canonical week boundary so a crafted
 * value can't create an off-grid week. RLS still scopes every write to the
 * caller's household regardless.
 */

import { revalidatePath } from "next/cache";

import { createServerComponentClient } from "@/lib/supabase/server-component";
import { isValidIsoDate, weekStartForDate } from "@/lib/week/boundary";

import {
  getOrCreateWeek,
  proposeExistingDish,
  proposeNewDish,
} from "./actions-core";

export type ProposeState = { error: string } | { added: true } | null;

const GENERIC_ERROR = "Something went wrong. Reload and try again.";

type Actor = {
  householdId: string;
  memberId: string;
  weekStartDay: number;
};

/**
 * Resolve the signed-in member's household + member id + week-start preference.
 * Returns null if the session/household can't be established (the middleware
 * normally prevents reaching here without a membership).
 */
async function resolveActor(
  supabase: Awaited<ReturnType<typeof createServerComponentClient>>,
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

/** Validate + normalize the untrusted weekStart, then lazily open the week. */
async function resolveWeekId(
  supabase: Awaited<ReturnType<typeof createServerComponentClient>>,
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

export async function proposeNewDishAction(
  _prev: ProposeState,
  formData: FormData,
): Promise<ProposeState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const week = await resolveWeekId(
    supabase,
    actor,
    String(formData.get("weekStart") ?? ""),
  );
  if ("error" in week) return { error: week.error };

  const result = await proposeNewDish(supabase, {
    householdId: actor.householdId,
    weekId: week.weekId,
    proposedBy: actor.memberId,
    title: String(formData.get("title") ?? ""),
    sourceUrl: String(formData.get("sourceUrl") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/board");
  return { added: true };
}

export async function recycleDishAction(
  _prev: ProposeState,
  formData: FormData,
): Promise<ProposeState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const week = await resolveWeekId(
    supabase,
    actor,
    String(formData.get("weekStart") ?? ""),
  );
  if ("error" in week) return { error: week.error };

  const result = await proposeExistingDish(supabase, {
    householdId: actor.householdId,
    weekId: week.weekId,
    proposedBy: actor.memberId,
    dishId: String(formData.get("dishId") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/board");
  return { added: true };
}
