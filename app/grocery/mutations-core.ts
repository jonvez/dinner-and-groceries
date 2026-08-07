/**
 * The shopper's four edits to the week's list (issue #15, slice 1d): add a
 * staple in one tap, type an ad-hoc item, mark "we already have it", and check
 * something off. Injected Supabase-like client (like `rollup-core`), so every
 * statement is unit-tested without a live DB; the thin Server Actions supply the
 * RLS-scoped cookie-session client.
 *
 * Security posture:
 *   - `householdId` always comes from the caller's VERIFIED session (the actor
 *     resolver), never from request input, and is written onto every insert so
 *     the `with check` policy applies (#13). There is no service-role path.
 *   - Row ids are NOT trusted: an id from another household simply matches no
 *     row under RLS, so the update affects nothing (fails closed, and the
 *     `catalog_items` read returns null before any write happens).
 *   - The toggles write ONE column each — a request can't ride along and
 *     re-home a row, rename it, or clear its provenance.
 *
 * Nothing here touches dishes/recipes/ingredients: `grocery_items` is an
 * independent table (SPEC.md), so editing the list never mutates the menu.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type MutationResult = { ok: true } | { ok: false; error: string };

/** One generic message for every failure — never leak a database error. */
export const GENERIC_ERROR = "Could not update the list.";
export const BLANK_NAME_ERROR = "Give the item a name.";

/** Injectable clock so `last_added_at` is deterministic under test. */
type Clock = { now?: () => Date };

/** Only a real, finite number is a quantity; anything else stays unquantified. */
function cleanQuantity(quantity: number | null | undefined): number | null {
  return typeof quantity === "number" && Number.isFinite(quantity) ? quantity : null;
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Add a known staple to this week's list and record the reach-for
 * (`added_count` / `last_added_at` — stored for future repurchase suggestions,
 * not surfaced in MVP). The staple's name + default unit are copied from the
 * catalog row we just READ under RLS, so a caller can never inject a name.
 */
export async function addCatalogItemToList(
  supabase: Pick<DbClient, "from">,
  input: {
    /** From the caller's VERIFIED session — never request input. */
    householdId: string;
    weekId: string;
    catalogItemId: string;
  } & Clock,
): Promise<MutationResult> {
  const clock = input.now ?? (() => new Date());

  const { data: staple } = await supabase
    .from("catalog_items")
    .select("id, name, default_unit, added_count")
    .eq("id", input.catalogItemId)
    .maybeSingle();

  // Not found, or not ours (RLS hides another household's staples) → fail closed.
  if (!staple) return { ok: false, error: GENERIC_ERROR };

  const { error: insertError } = await supabase.from("grocery_items").insert({
    household_id: input.householdId,
    week_id: input.weekId,
    name: staple.name,
    // A staple carries no quantity by default — the shopper knows "milk".
    quantity: null,
    unit: staple.default_unit,
    catalog_item_id: staple.id,
    ingredient_id: null,
  });
  if (insertError) return { ok: false, error: GENERIC_ERROR };

  // Best-effort usage bump: the item IS on the list even if this fails, so a
  // failure here is surfaced as a generic error but leaves a valid list row.
  const { error: bumpError } = await supabase
    .from("catalog_items")
    .update({
      added_count: (staple.added_count ?? 0) + 1,
      last_added_at: clock().toISOString(),
    })
    .eq("id", staple.id);
  if (bumpError) return { ok: false, error: GENERIC_ERROR };

  return { ok: true };
}

/**
 * Add a typed item with NO provenance — both feeder FKs null (the third feeder
 * of the three-feeder model). Quantity and unit are optional: "eggs" is a valid
 * list row and must never be coerced to a quantity of 1.
 */
export async function addAdHocItem(
  supabase: Pick<DbClient, "from">,
  input: {
    /** From the caller's VERIFIED session — never request input. */
    householdId: string;
    weekId: string;
    name: string;
    quantity: number | null;
    unit: string | null;
  },
): Promise<MutationResult> {
  const name = (input.name ?? "").trim();
  // The DB check constraint also rejects this; catching it here gives the
  // shopper a real message instead of a generic write failure.
  if (name === "") return { ok: false, error: BLANK_NAME_ERROR };

  const { error } = await supabase.from("grocery_items").insert({
    household_id: input.householdId,
    week_id: input.weekId,
    name,
    quantity: cleanQuantity(input.quantity),
    unit: cleanText(input.unit),
    ingredient_id: null,
    catalog_item_id: null,
  });
  if (error) return { ok: false, error: GENERIC_ERROR };

  return { ok: true };
}

/**
 * "We already have it" — de-emphasizes the row in the UI and protects it from a
 * re-roll-up (ADR 0003). Never deletes: the shopper may change their mind in the
 * aisle.
 */
export async function setHaveIt(
  supabase: Pick<DbClient, "from">,
  input: { id: string; haveIt: boolean },
): Promise<MutationResult> {
  const { error } = await supabase
    .from("grocery_items")
    .update({ have_it: input.haveIt })
    .eq("id", input.id);
  if (error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}

/** Check-off / un-check — the edit that propagates live to the other shopper. */
export async function setChecked(
  supabase: Pick<DbClient, "from">,
  input: { id: string; checked: boolean },
): Promise<MutationResult> {
  const { error } = await supabase
    .from("grocery_items")
    .update({ checked: input.checked })
    .eq("id", input.id);
  if (error) return { ok: false, error: GENERIC_ERROR };
  return { ok: true };
}
