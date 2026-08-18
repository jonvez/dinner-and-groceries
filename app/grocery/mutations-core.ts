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
 *     `catalog_items` read returns null before any write happens). Note a
 *     Supabase update matching ZERO rows returns `error: null`, so the toggles
 *     answer `{ ok: true }` having changed nothing. That is DELIBERATE: an
 *     identical response for "not yours", "doesn't exist", and "done" denies an
 *     existence oracle. Do not "fix" it into a not-found error.
 *   - The toggles write ONE column each — a request can't ride along and
 *     re-home a row, rename it, or clear its provenance.
 *
 * Nothing here touches dishes/recipes/ingredients: `grocery_items` is an
 * independent table (SPEC.md), so editing the list never mutates the menu.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { inheritSectionId, loadCatalogSectionIndex } from "./sections-core";

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
    .select("id, name, default_unit, added_count, section_id")
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
    // The staple's DURABLE aisle, snapshotted onto the list row.
    section_id: staple.section_id,
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
 *
 * Section inheritance (#137): if the typed name matches a known staple, the row
 * lands in that staple's aisle instead of Unsorted — so typing "mozzarella"
 * files itself under Dairy without anyone touching it. Only `section_id` is
 * copied; `catalog_item_id` stays NULL, because setting it would change the
 * row's provenance and hand it to the roll-up's protection rules.
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

  const catalogIndex = await loadCatalogSectionIndex(supabase, {
    householdId: input.householdId,
  });

  const { error } = await supabase.from("grocery_items").insert({
    household_id: input.householdId,
    week_id: input.weekId,
    name,
    quantity: cleanQuantity(input.quantity),
    unit: cleanText(input.unit),
    ingredient_id: null,
    catalog_item_id: null,
    section_id: inheritSectionId(name, catalogIndex),
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

/**
 * Check-off / un-check — the edit that propagates live to the other shopper.
 * A foreign or nonexistent id matches no row under RLS and returns `ok` without
 * changing anything (uniform response, no existence oracle — see the header).
 */
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

/**
 * Move an item to a section — and make it stick (#137).
 *
 * This is the write-through that justifies the whole feature. The family's old
 * workflow re-sorted the same items into the same groups on every single trip,
 * because the grouping was never stored. So a move here updates BOTH:
 *
 *   1. the grocery row, so the list regroups immediately, and
 *   2. the DURABLE staple in the catalog, so next week it arrives correct.
 *
 * The catalog row is found by `catalog_item_id` when the item came from a
 * staple, and otherwise by a case-insensitive name match — a typed "mozzarella"
 * still teaches the "Mozzarella" staple where it lives. An ad-hoc item with no
 * matching staple simply has nothing durable to update yet; it carries its
 * section into the catalog later, when the trip is completed and it is promoted.
 *
 * Step 2 is best-effort by design: if the durable update fails, the item has
 * still moved on this trip. Reporting failure would imply the visible move did
 * not happen, which is worse than a section that needs correcting once more.
 *
 * `sectionId` is NOT validated here against the household's sections — it does
 * not need to be. The composite `(section_id, household_id)` FK makes a foreign
 * section unstorable at the database, so a crafted id fails the write outright
 * rather than being silently accepted.
 */
export async function setItemSection(
  supabase: Pick<DbClient, "from">,
  input: {
    /** From the caller's VERIFIED session — never request input. */
    householdId: string;
    id: string;
    /** null clears the section, which renders as Unsorted. */
    sectionId: string | null;
  },
): Promise<MutationResult> {
  // Read the row first: we need its name and provenance to find the staple to
  // teach. RLS scopes this, so another household's id reads back nothing.
  const { data: item } = await supabase
    .from("grocery_items")
    .select("id, name, catalog_item_id")
    .eq("id", input.id)
    .maybeSingle();

  // Not found, or not ours → fail closed, exactly like addCatalogItemToList.
  if (!item) return { ok: false, error: GENERIC_ERROR };

  const { error } = await supabase
    .from("grocery_items")
    .update({ section_id: input.sectionId })
    .eq("id", input.id);
  if (error) return { ok: false, error: GENERIC_ERROR };

  // ---- write-through to the durable staple (best-effort, see header) ----
  let catalogItemId = (item as { catalog_item_id: string | null }).catalog_item_id;

  if (catalogItemId === null) {
    const index = await loadCatalogSectionIndex(supabase, {
      householdId: input.householdId,
    });
    catalogItemId =
      index.get((item as { name: string }).name.trim().toLowerCase())?.id ?? null;
  }

  if (catalogItemId !== null) {
    await supabase
      .from("catalog_items")
      .update({ section_id: input.sectionId })
      .eq("id", catalogItemId);
  }

  return { ok: true };
}
