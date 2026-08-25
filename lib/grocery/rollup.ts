/**
 * The roll-up / dedupe planner (issue #14, Slice 1d): turns a week's slotted
 * ingredient lines plus the family's CURRENT grocery list into a plan of
 * inserts / updates / deletes. Pure — no I/O, no Supabase — so the riskiest
 * logic in the slice is exhaustively unit-tested; `app/grocery/rollup-core.ts`
 * owns the reads/writes that feed and apply it.
 *
 * Rules of record (ADR 0003 + the 2026-08-07 kickoff):
 *   - Dedupe key = `normalizeName(name)` + EXACT unit. No unit conversion; two
 *     un-mergeable units are simply two rows. An empty/absent unit is its OWN
 *     key (two unit-less "eggs" merge), and never merges with a real unit.
 *   - Quantity and unit are OPTIONAL. Summing adds only present values — a null
 *     contributes nothing and is never coerced to 1; if every contributor is
 *     null the merged quantity stays null (an unquantified item is valid).
 *   - Merge, never clobber. A row is PROTECTED if the family touched it
 *     (`edited || checked || haveIt`) or it isn't dish-derived
 *     (`ingredientId === null` — catalog/ad-hoc). Protected rows are never
 *     updated or deleted, and they CLAIM their dedupe key so the roll-up never
 *     inserts a shadow duplicate next to a hand-edited row.
 *   - Untouched-only removal. An untouched auto-row whose key is no longer
 *     produced by the current slotting is deleted; nothing else ever is.
 *   - "N added, M removed" = rows inserted / untouched auto-rows deleted. A
 *     quantity refresh on a surviving row is neither.
 */

import { normalizeName } from "@/lib/recipes/ingredient";

/** One ingredient line contributed by one slotting of one dish. */
export type SlottedIngredient = {
  /** `ingredients.id` — provenance carried onto the grocery row. */
  ingredientId: string;
  /** Display name, original case. Normalized only at dedupe time. */
  name: string;
  quantity: number | null;
  unit: string | null;
};

/** A row already on the week's active list (not purchased/archived). */
export type ExistingGroceryItem = {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  /** null ⇒ catalog or ad-hoc, i.e. not dish-derived ⇒ protected. */
  ingredientId: string | null;
  haveIt: boolean;
  checked: boolean;
  edited: boolean;
  /**
   * The week this row was CREATED in — provenance, not scope. Since the list
   * stopped being week-scoped, the planner sees unbought rows from earlier
   * weeks; this is what keeps a rebuild from deleting them.
   */
  weekId: string;
};

export type RolledUpInsert = {
  name: string;
  quantity: number | null;
  unit: string | null;
  /** Provenance of the first contributor to this merged row. */
  ingredientId: string;
};

export type RolledUpUpdate = { id: string; quantity: number | null; ingredientId: string };

export type RollupPlan = {
  toInsert: RolledUpInsert[];
  toUpdate: RolledUpUpdate[];
  /** `grocery_items.id`s of untouched auto-rows with no current source. */
  toDelete: string[];
  /** == `toInsert.length` */
  added: number;
  /** == `toDelete.length` */
  removed: number;
};

/**
 * A character that cannot appear in a name or a unit, so `("chicken", "fl oz")`
 * and `("chicken fl", "oz")` can never collide into one key.
 */
const SEP = "\u0000";

function dedupeKey(name: string, unit: string | null): string {
  return normalizeName(name) + SEP + (unit ?? "");
}

/** Sum of the PRESENT values, or null when there are none. Never coerces null to 0/1. */
function sumQuantities(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/** Touched by the family, or not dish-derived ⇒ the roll-up must not touch it. */
function isProtected(row: ExistingGroceryItem): boolean {
  return row.edited || row.checked || row.haveIt || row.ingredientId === null;
}

type DesiredRow = {
  name: string;
  quantities: (number | null)[];
  unit: string | null;
  ingredientId: string;
};

export function planRollup(
  slotted: SlottedIngredient[],
  existing: ExistingGroceryItem[],
  /**
   * The week being rebuilt. Rows created in ANY week take part in dedupe and
   * protection — otherwise last week's unbought leeks and this week's slotted
   * leeks would both sit on the list — but only rows from THIS week may be
   * deleted. Explicit rather than inferred: getting it wrong silently destroys
   * a row the family still needs, which is the failure this whole change set
   * exists to prevent.
   */
  { weekId }: { weekId: string },
): RollupPlan {
  // 1) Aggregate the week's slotting into the rows we WANT, keyed by
  //    (normalized name, exact unit). Insertion order is preserved, so the
  //    first contributor supplies the display name + provenance.
  const desired = new Map<string, DesiredRow>();
  for (const s of slotted) {
    const key = dedupeKey(s.name, s.unit);
    const cur = desired.get(key);
    if (cur) cur.quantities.push(s.quantity);
    else {
      desired.set(key, {
        name: s.name,
        quantities: [s.quantity],
        unit: s.unit,
        ingredientId: s.ingredientId,
      });
    }
  }

  // 2) Classify what's already on the list. A protected row claims its key
  //    outright; auto-rows are indexed first-wins (a duplicate auto-row for a
  //    still-slotted key is left alone — it is not stale).
  const protectedKeys = new Set<string>();
  const autoByKey = new Map<string, ExistingGroceryItem>();
  const autoDuplicates: ExistingGroceryItem[] = [];
  for (const row of existing) {
    const key = dedupeKey(row.name, row.unit);
    if (isProtected(row)) protectedKeys.add(key);
    else if (!autoByKey.has(key)) autoByKey.set(key, row);
    else autoDuplicates.push(row);
  }

  const toInsert: RolledUpInsert[] = [];
  const toUpdate: RolledUpUpdate[] = [];

  for (const [key, d] of desired) {
    // A hand-edited / checked / have-it / ad-hoc row owns this key: leave it be.
    if (protectedKeys.has(key)) continue;

    const quantity = sumQuantities(d.quantities);
    const existingAuto = autoByKey.get(key);
    if (existingAuto) {
      // Refresh in place only when the number actually moved — an unchanged row
      // must not churn the list (and is neither "added" nor "removed").
      if (existingAuto.quantity !== quantity) {
        toUpdate.push({ id: existingAuto.id, quantity, ingredientId: d.ingredientId });
      }
    } else {
      toInsert.push({ name: d.name, quantity, unit: d.unit, ingredientId: d.ingredientId });
    }
  }

  // 3) Untouched auto-rows the current slotting no longer produces — including
  //    any duplicates of such a key — are the ONLY rows we ever delete.
  const toDelete: string[] = [];
  for (const row of [...autoByKey.values(), ...autoDuplicates]) {
    // Another week's row is never ours to delete: this rebuild knows nothing
    // about the menu that produced it.
    if (row.weekId !== weekId) continue;
    if (!desired.has(dedupeKey(row.name, row.unit))) toDelete.push(row.id);
  }

  return { toInsert, toUpdate, toDelete, added: toInsert.length, removed: toDelete.length };
}
