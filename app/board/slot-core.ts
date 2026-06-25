/**
 * Pure orchestration for tap-to-slot / tap-to-unslot (issue #10). Like the other
 * board cores, these take an injected Supabase-like client so they're unit-tested
 * WITHOUT a live DB. The thin Server Actions (`slot-actions.ts`) build the real
 * RLS-scoped cookie-session client (no service-role key), resolve the caller's
 * household + week from the VERIFIED session, then call these.
 *
 * Modeling contract (SPEC "Deliberate modeling choices"; ADR 0003; #7 schema):
 *   - A slot is the meal occasion (week + day_of_week + meal_type). Slotting is
 *     "find-or-create that slot, then add a slot_dishes row." A slot holds MANY
 *     dishes (spaghetti + salad).
 *   - Duplicate slotting is allowed: slotting the same dish twice creates two
 *     slot_dishes rows (it rolls up twice later) — so slotDish never dedupes.
 *   - Slotting is purely DELIBERATE: nothing here reads reactions. The nudge sort
 *     + badge only GUIDE which dish a human chooses to slot (lib/social/nudge).
 *   - Reversible: unslotDish removes exactly one slot_dishes row; re-slotting and
 *     swapping are just slot/unslot calls.
 *
 * Idempotency note (find-or-create): getOrCreateSlot UPSERTs on the natural key
 * (week_id, day_of_week, meal_type). This is the ONLY safe way to make concurrent
 * taps / re-renders converge on a single slot. It REQUIRES a UNIQUE constraint on
 * those columns; with the constraint absent the upsert ERRORS (loud) rather than
 * silently creating duplicate slots. See the PR description — that constraint is a
 * surfaced schema decision, not added unilaterally here.
 *
 * Security: householdId/weekId come from the caller (verified session), never form
 * input. The untrusted meal_type / day_of_week are validated against the allowed
 * set HERE (defense in depth — the action validates too). RLS + the composite
 * (week_id, household_id) / (slot_id, household_id) / (dish_id, household_id) FKs
 * scope every write to the caller's own household — no cross-household slotting.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { isValidDayOfWeek } from "@/lib/week/boundary";
import { isMealType } from "@/lib/week/labels";

type DbClient = SupabaseClient<Database>;

export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const GENERIC = "We couldn't update the board. Please try again.";

/**
 * Find-or-create the slot for (week_id, day_of_week, meal_type) via an idempotent
 * UPSERT on that natural key, returning its id. Validates the untrusted target
 * first so an off-grid day or unknown meal can't reach the DB.
 */
export async function getOrCreateSlot(
  supabase: Pick<DbClient, "from">,
  input: {
    householdId: string;
    weekId: string;
    dayOfWeek: number;
    mealType: string;
  },
): Promise<ActionResult<{ slotId: string }>> {
  if (!isMealType(input.mealType) || !isValidDayOfWeek(input.dayOfWeek)) {
    return { ok: false, error: GENERIC };
  }

  const { data, error } = await supabase
    .from("slots")
    .upsert(
      {
        household_id: input.householdId,
        week_id: input.weekId,
        day_of_week: input.dayOfWeek,
        meal_type: input.mealType,
      },
      { onConflict: "week_id,day_of_week,meal_type" },
    )
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: GENERIC };
  return { ok: true, slotId: data.id };
}

/**
 * Slot a proposed dish onto a day + meal-type: find-or-create the slot, then add
 * a slot_dishes row. Duplicate slotting is intentionally permitted (no dedupe).
 */
export async function slotDish(
  supabase: Pick<DbClient, "from">,
  input: {
    householdId: string;
    weekId: string;
    dishId: string;
    dayOfWeek: number;
    mealType: string;
  },
): Promise<ActionResult<{ slotId: string; slotDishId: string }>> {
  if (input.dishId.trim() === "") {
    return { ok: false, error: GENERIC };
  }

  const slot = await getOrCreateSlot(supabase, {
    householdId: input.householdId,
    weekId: input.weekId,
    dayOfWeek: input.dayOfWeek,
    mealType: input.mealType,
  });
  if (!slot.ok) return slot;

  const { data, error } = await supabase
    .from("slot_dishes")
    .insert({
      household_id: input.householdId,
      slot_id: slot.slotId,
      dish_id: input.dishId,
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: GENERIC };
  return { ok: true, slotId: slot.slotId, slotDishId: data.id };
}

/**
 * Unslot: remove exactly one slot_dishes row by id (RLS scopes the delete to the
 * caller's household). Re-slotting and swapping are just further slot/unslot calls.
 */
export async function unslotDish(
  supabase: Pick<DbClient, "from">,
  input: { slotDishId: string },
): Promise<ActionResult<{ removed: true }>> {
  if (input.slotDishId.trim() === "") {
    return { ok: false, error: GENERIC };
  }

  const { error } = await supabase
    .from("slot_dishes")
    .delete()
    .eq("id", input.slotDishId);

  if (error) return { ok: false, error: GENERIC };
  return { ok: true, removed: true };
}
