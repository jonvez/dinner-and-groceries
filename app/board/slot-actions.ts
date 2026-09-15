"use server";

/**
 * Server Actions for tap-to-slot / tap-to-unslot (issue #10) — the thin Next.js
 * boundary. Build the RLS-scoped cookie-session client (runs as the signed-in
 * user; no service-role key), resolve the caller's household + member identity and
 * the week from the VERIFIED session (never from form input), delegate to the pure
 * `slot-core` writes, then revalidate the board so the actor's own view refreshes.
 *
 * Untrusted input handling: `weekStart` is validated + re-normalized to the
 * household's canonical boundary (resolveWeekId); `meal_type` / `day_of_week` are
 * validated against the allowed set HERE and again in core (defense in depth);
 * `dishId` / `slotDishId` are scoped by RLS + the composite FKs, so a member can
 * only slot a dish in — and unslot a slot_dishes row of — their own household.
 *
 * Analytics (issue #210): `slot_filled` is emitted on a successful slot only.
 * Unslotting emits NOTHING — there is no `slot_emptied` in the taxonomy, and the
 * dashboard counts menus that got agreed, not edits back and forth.
 */

import { revalidatePath } from "next/cache";

import { emitEvent } from "@/lib/analytics/events";
import { createServerComponentClient } from "@/lib/supabase/server-component";
import { isValidDayOfWeek } from "@/lib/week/boundary";
import { isMealType } from "@/lib/week/labels";

import { GENERIC_ERROR, resolveActor, resolveWeekId } from "./actor";
import { slotDish, unslotDish } from "./slot-core";

export type SlotState = { error: string } | { slotted: true } | null;
export type UnslotState = { error: string } | { unslotted: true } | null;

/** Parse an untrusted form value into a day-of-week number, or NaN if absent. */
function parseDayOfWeek(raw: FormDataEntryValue | null): number {
  if (typeof raw !== "string" || raw.trim() === "") return NaN;
  return Number(raw);
}

export async function slotDishAction(
  _prev: SlotState,
  formData: FormData,
): Promise<SlotState> {
  const mealType = String(formData.get("mealType") ?? "");
  const dayOfWeek = parseDayOfWeek(formData.get("dayOfWeek"));
  // Reject an off-grid day / unknown meal up front (core re-checks).
  if (!isMealType(mealType) || !isValidDayOfWeek(dayOfWeek)) {
    return { error: "Pick a day and meal to slot this onto." };
  }

  const supabase = await createServerComponentClient();
  const actor = await resolveActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const week = await resolveWeekId(
    supabase,
    actor,
    String(formData.get("weekStart") ?? ""),
  );
  if ("error" in week) return { error: week.error };

  const dishId = String(formData.get("dishId") ?? "");

  const result = await slotDish(supabase, {
    householdId: actor.householdId,
    weekId: week.weekId,
    dishId,
    dayOfWeek,
    mealType,
  });
  if (!result.ok) return { error: result.error };

  // `dayOfWeek` / `mealType` are the validated coordinates the write used.
  await emitEvent(supabase, {
    householdId: actor.householdId,
    memberId: actor.memberId,
    eventType: "slot_filled",
    payload: { slotDishId: result.slotDishId, dishId, dayOfWeek, mealType },
  });

  revalidatePath("/board");
  return { slotted: true };
}

export async function unslotDishAction(
  _prev: UnslotState,
  formData: FormData,
): Promise<UnslotState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const result = await unslotDish(supabase, {
    slotDishId: String(formData.get("slotDishId") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/board");
  return { unslotted: true };
}
