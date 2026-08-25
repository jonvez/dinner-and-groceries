/**
 * Persisting orchestration for the week's grocery roll-up (issue #14, Slice
 * 1d). Like `app/recipes/new/ingest-core.ts`, it takes an INJECTED Supabase-like
 * client so it is unit-tested without a live DB; the thin Server Action
 * (`actions.ts`) supplies the RLS-scoped cookie-session client and the caller's
 * verified household.
 *
 * Shape: read the week's slotted dishes → their ingredient lines, read the
 * ACTIVE (un-purchased) grocery list, hand both to the pure planner
 * (`lib/grocery/rollup.ts`), then apply its plan. All merge/dedupe/removal
 * judgement lives in the planner; this module only moves rows.
 *
 * Security: every statement runs as the signed-in user under RLS — NEVER a
 * service-role key. `householdId` comes from the caller's verified session (the
 * actor resolver), never from request input, and is written onto every inserted
 * row; `weekId` only ever narrows a read/write that RLS already scopes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  planRollup,
  type ExistingGroceryItem,
  type SlottedIngredient,
} from "@/lib/grocery/rollup";

import { inheritSectionId, loadCatalogSectionIndex } from "./sections-core";

type DbClient = SupabaseClient<Database>;

export type BuildGroceryListArgs = {
  /** From the caller's VERIFIED session — never request input. */
  householdId: string;
  weekId: string;
};

export type BuildGroceryListResult =
  | { ok: true; added: number; removed: number }
  | { ok: false; error: string };

/** One generic message for every failure — never leak a database error. */
const GENERIC_ERROR = "Could not build the grocery list.";

/** The embed shape of the slots → slot_dishes → dishes → ingredients read. */
type SlotEmbedRow = {
  slot_dishes:
    | {
        dish: { ingredients: SlottedIngredientRow[] | null } | null;
      }[]
    | null;
};
type SlottedIngredientRow = {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
};

type GroceryItemRow = {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  ingredient_id: string | null;
  catalog_item_id: string | null;
  have_it: boolean;
  checked: boolean;
  edited: boolean;
  week_id: string;
};

/**
 * Every ingredient line of every slotted dish, in slot → dish → position order.
 * A dish slotted twice appears in two `slot_dishes` rows and so contributes its
 * lines TWICE — that duplicate slotting is what the planner sums (ADR 0003).
 */
function flattenSlottedIngredients(rows: SlotEmbedRow[]): SlottedIngredient[] {
  return rows.flatMap((slot) =>
    (slot.slot_dishes ?? []).flatMap((slotDish) =>
      (slotDish.dish?.ingredients ?? []).map((ingredient) => ({
        ingredientId: ingredient.id,
        name: ingredient.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
      })),
    ),
  );
}

/**
 * A stored row in the planner's vocabulary. A catalog row (`catalog_item_id`
 * set, `ingredient_id` null) maps to `ingredientId: null` — i.e. not
 * dish-derived, therefore protected.
 */
function toExistingItem(row: GroceryItemRow): ExistingGroceryItem {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    ingredientId: row.ingredient_id,
    haveIt: row.have_it,
    checked: row.checked,
    edited: row.edited,
    weekId: row.week_id,
  };
}

/**
 * Rebuild `weekId`'s grocery list from its slotted dishes, merging (never
 * clobbering) the family's manual edits. Returns "N added, M removed" for the
 * UI, or one generic error — a read failure writes nothing at all, and a write
 * failure is surfaced rather than silently reported as success.
 */
export async function buildGroceryList(
  supabase: Pick<DbClient, "from">,
  { householdId, weekId }: BuildGroceryListArgs,
): Promise<BuildGroceryListResult> {
  const { data: slotRows, error: slotsError } = await supabase
    .from("slots")
    .select("slot_dishes(dish:dishes(ingredients(id, name, quantity, unit)))")
    .eq("week_id", weekId);
  if (slotsError) return { ok: false, error: GENERIC_ERROR };

  // Only the ACTIVE list: purchased/archived rows are a past trip, out of the
  // roll-up's scope, and must never be revived or deleted by a rebuild.
  //
  // Deliberately NOT filtered by week. The list stopped being week-scoped (the
  // 2026-08-24 rollover bug), so a row the family added weeks ago and still
  // hasn't bought is on the list today and must take part in dedupe and
  // protection — otherwise slotting a dish that needs leeks would add a SECOND
  // "Leeks" line beside the one already sitting there. `planRollup` is told
  // which week is being rebuilt so it still only ever deletes rows from THAT
  // week; reading wider must not mean deleting wider.
  const { data: itemRows, error: itemsError } = await supabase
    .from("grocery_items")
    .select(
      "id, name, quantity, unit, ingredient_id, catalog_item_id, have_it, checked, edited, week_id",
    )
    .is("purchased_at", null);
  if (itemsError) return { ok: false, error: GENERIC_ERROR };

  const slotted = flattenSlottedIngredients((slotRows ?? []) as unknown as SlotEmbedRow[]);
  const existing = ((itemRows ?? []) as unknown as GroceryItemRow[]).map(toExistingItem);

  const plan = planRollup(slotted, existing, { weekId });

  // Refresh surviving auto-rows first, then drop stale ones, then insert the
  // new arrivals — so a rebuild never briefly shows a duplicate row.
  for (const update of plan.toUpdate) {
    const { error } = await supabase
      .from("grocery_items")
      .update({ quantity: update.quantity, ingredient_id: update.ingredientId })
      .eq("id", update.id);
    if (error) return { ok: false, error: GENERIC_ERROR };
  }

  if (plan.toDelete.length > 0) {
    const { error } = await supabase.from("grocery_items").delete().in("id", plan.toDelete);
    if (error) return { ok: false, error: GENERIC_ERROR };
  }

  if (plan.toInsert.length > 0) {
    // Dish-derived rows inherit an aisle from a known staple of the same name
    // (#137), so a menu rebuild lands "leeks" under Produce rather than dumping
    // the whole week's ingredients into Unsorted. Read once for the batch, for
    // the same reason promoteToCatalog does — see the trip-core.ts header on why
    // a per-name `ilike` is not safe with user-typed text.
    const catalogIndex = await loadCatalogSectionIndex(supabase, { householdId });

    const { error } = await supabase.from("grocery_items").insert(
      plan.toInsert.map((row) => ({
        household_id: householdId,
        week_id: weekId,
        name: row.name,
        quantity: row.quantity,
        unit: row.unit,
        ingredient_id: row.ingredientId,
        section_id: inheritSectionId(row.name, catalogIndex),
      })),
    );
    if (error) return { ok: false, error: GENERIC_ERROR };
  }

  return { ok: true, added: plan.added, removed: plan.removed };
}
