/**
 * The read half of the shopping list (issue #15, slice 1d): the household's
 * ACTIVE grocery rows plus its staples catalog, in the shape the client
 * component renders. Takes an INJECTED Supabase-like client (like `rollup-core`)
 * so it is unit-tested without a live DB; the server component supplies the
 * RLS-scoped cookie-session client.
 *
 * Security: no `household_id` filter and no service-role key — RLS scopes every
 * read here to the caller's household (ADR 0003).
 *
 * Degradation: a failed read yields empty arrays rather than throwing, so the
 * page still renders (with its add forms and "rebuild from menu") instead of
 * 500ing in the middle of a grocery aisle.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import { loadSections, type SectionRow } from "./sections-core";

type DbClient = SupabaseClient<Database>;

/** The columns the list UI needs — camelCase mapping of a `grocery_items` row. */
export type GroceryRow = {
  id: string;
  name: string;
  /** Optional: an unquantified item ("eggs") is valid — never coerce to 0/1. */
  quantity: number | null;
  unit: string | null;
  /** Set when the row came from a slotted dish's ingredient ("from the menu"). */
  ingredientId: string | null;
  /** Set when the row was added from the staples catalog. */
  catalogItemId: string | null;
  haveIt: boolean;
  checked: boolean;
  edited: boolean;
  position: number;
  createdAt: string;
  /** null renders as Unsorted — see the sections-core.ts header. */
  sectionId: string | null;
};

/** A staple, offered as an autocomplete suggestion and (once earned) a chip. */
export type CatalogRow = {
  id: string;
  name: string;
  defaultUnit: string | null;
  /**
   * How many times the app has added this staple to a list. A real signal —
   * bumped by `addCatalogItemToList` and `promoteToCatalog` — but note the
   * values IMPORTED from Things are an artifact of that tool's workflow, not
   * purchases, and are reset at the #148 deploy (see the issue).
   */
  addedCount: number;
};

export type GroceryListSnapshot = {
  items: GroceryRow[];
  catalog: CatalogRow[];
  /** The household's aisles, in order — the client renders one group each. */
  sections: SectionRow[];
};

/** Selected columns, shared with the client component's Realtime re-fetch. */
export const GROCERY_ITEM_COLUMNS =
  "id, name, quantity, unit, ingredient_id, catalog_item_id, have_it, checked, edited, position, created_at, section_id";

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
  position: number;
  created_at: string;
  section_id: string | null;
};

type CatalogItemRow = {
  id: string;
  name: string;
  default_unit: string | null;
  added_count: number | null;
};

export function toGroceryRow(row: GroceryItemRow): GroceryRow {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    ingredientId: row.ingredient_id,
    catalogItemId: row.catalog_item_id,
    haveIt: row.have_it,
    checked: row.checked,
    edited: row.edited,
    position: row.position,
    createdAt: row.created_at,
    sectionId: row.section_id,
  };
}

/**
 * Load the ACTIVE list (`purchased_at is null` — a completed trip's rows are
 * archived, not shown) in stable shopping order, plus the staples catalog with
 * the most-reached-for items first.
 *
 * "Active" spans every week: see the note on the read below.
 */
export async function loadGroceryList(
  supabase: Pick<DbClient, "from">,
): Promise<GroceryListSnapshot> {
  // Deliberately NOT scoped to `weekId`. The shopping list is a ROLLING list:
  // an item nobody bought is still needed tomorrow, and the week it was typed
  // in is provenance, not scope. Filtering here is what made everything added
  // before a week boundary vanish (2026-08-24) — the rows were intact, just
  // unreachable, which to the family is indistinguishable from losing them.
  // The week is still resolved by the page — new rows record it, and the menu
  // roll-up still uses it — but this read takes no `weekId` at all, so nobody
  // can reintroduce the scope by quietly passing one.
  const { data: itemRows } = await supabase
    .from("grocery_items")
    .select(GROCERY_ITEM_COLUMNS)
    .is("purchased_at", null)
    .order("position")
    .order("created_at");

  // RLS scopes this to the caller's household, like the catalog read below.
  const sections = await loadSections(supabase);

  const { data: catalogRows } = await supabase
    .from("catalog_items")
    .select("id, name, default_unit, added_count")
    .order("added_count", { ascending: false })
    .order("name");

  return {
    sections,
    items: ((itemRows ?? []) as unknown as GroceryItemRow[]).map(toGroceryRow),
    catalog: ((catalogRows ?? []) as unknown as CatalogItemRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      defaultUnit: row.default_unit,
      addedCount: row.added_count ?? 0,
    })),
  };
}
