/**
 * Finishing a shopping trip (issue #15, slice 1d): soft-archive everything in
 * the cart, then promote the newly-typed items into the household's staples
 * catalog so next week they're one tap away. Injected Supabase-like client, so
 * both steps are unit-tested without a live DB.
 *
 * Two deliberate shapes:
 *   - **Archive, don't delete.** Checked rows get a `purchased_at` stamp; the
 *     active list is `purchased_at is null` (#13/#14). The trip stays in history
 *     and a re-roll-up can never revive it.
 *   - **Promotion is an explicit, separate step.** `completeTrip` only OFFERS
 *     candidates; the shopper confirms which ones become staples, and only then
 *     does `promoteToCatalog` write. Nothing is force-added to the catalog.
 *
 * Security: `householdId` comes from the caller's VERIFIED session (the actor
 * resolver) — it is written on insert and also filters the lookup, so promotion
 * can only ever touch the caller's own catalog. Every statement runs under RLS
 * as the signed-in user; there is no service-role key. Upsert-by-lower(name) is
 * a check-then-write in TypeScript (no RPC, no elevated privilege); the
 * `(household_id, lower(name))` unique index is the real referee, so a
 * concurrent duplicate is absorbed rather than surfaced as an error.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type CompleteTripResult =
  | { ok: true; archived: number; promotable: string[] }
  | { ok: false; error: string };

export type PromoteResult =
  | { ok: true; promoted: number }
  | { ok: false; error: string };

export const TRIP_ERROR = "Could not complete the trip.";
export const PROMOTE_ERROR = "Could not add those to your staples.";

/** Postgres unique-violation — someone else promoted the same name first. */
const UNIQUE_VIOLATION = "23505";

/** Injectable clock so the archive stamp is deterministic under test. */
type Clock = { now?: () => Date };

type ArchivedRow = {
  id: string;
  name: string;
  ingredient_id: string | null;
  catalog_item_id: string | null;
};

/**
 * Escape the LIKE metacharacters in a user-typed name before it becomes an
 * `ilike` pattern. Without this, "50% cream" would wildcard-match an unrelated
 * staple (and a `%`-heavy name could match several rows, breaking maybeSingle).
 * PostgREST passes the pattern straight to ILIKE, whose default escape is `\`.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Archive the cart: stamp `purchased_at` on every checked, not-yet-purchased row
 * in this week, and return the count plus the distinct AD-HOC names (both feeder
 * FKs null) as promotion candidates. A dish-derived line isn't a staple; a
 * catalog-fed row already is one.
 */
export async function completeTrip(
  supabase: Pick<DbClient, "from">,
  input: {
    /** From the caller's VERIFIED session — never request input. */
    householdId: string;
    weekId: string;
  } & Clock,
): Promise<CompleteTripResult> {
  const clock = input.now ?? (() => new Date());

  // RLS scopes this to the caller's household; the filters below only narrow it
  // to "this week's cart". `RETURNING` gives us the count AND the candidates in
  // one round trip, with no read-then-write race.
  const { data, error } = await supabase
    .from("grocery_items")
    .update({ purchased_at: clock().toISOString() })
    .eq("week_id", input.weekId)
    .eq("checked", true)
    .is("purchased_at", null)
    .select("id, name, ingredient_id, catalog_item_id");

  if (error) return { ok: false, error: TRIP_ERROR };

  const rows = (data ?? []) as unknown as ArchivedRow[];

  // Distinct ad-hoc names, case-insensitive, keeping the first spelling the
  // family used (that's the one they'll recognize in the catalog).
  const seen = new Set<string>();
  const promotable: string[] = [];
  for (const row of rows) {
    if (row.ingredient_id !== null || row.catalog_item_id !== null) continue;
    const name = row.name.trim();
    if (name === "") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    promotable.push(name);
  }

  return { ok: true, archived: rows.length, promotable };
}

/**
 * Promote the accepted names into the staples catalog: bump an existing staple
 * (matched case-insensitively, mirroring the `(household_id, lower(name))`
 * unique index) or insert a new one with `added_count = 1`.
 */
export async function promoteToCatalog(
  supabase: Pick<DbClient, "from">,
  input: {
    /** From the caller's VERIFIED session — never request input. */
    householdId: string;
    names: string[];
  } & Clock,
): Promise<PromoteResult> {
  const clock = input.now ?? (() => new Date());
  let promoted = 0;

  for (const raw of input.names ?? []) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name === "") continue;

    const { data: existing, error: lookupError } = await supabase
      .from("catalog_items")
      .select("id, added_count")
      .eq("household_id", input.householdId)
      .ilike("name", escapeLikePattern(name))
      .maybeSingle();
    if (lookupError) return { ok: false, error: PROMOTE_ERROR };

    if (existing) {
      const { error } = await supabase
        .from("catalog_items")
        .update({
          added_count: (existing.added_count ?? 0) + 1,
          last_added_at: clock().toISOString(),
        })
        .eq("id", existing.id);
      if (error) return { ok: false, error: PROMOTE_ERROR };
    } else {
      const { error } = await supabase.from("catalog_items").insert({
        household_id: input.householdId,
        name,
        added_count: 1,
        last_added_at: clock().toISOString(),
      });
      // A unique violation means the other shopper promoted the same name
      // between our lookup and insert — the staple exists, which is the outcome
      // the user asked for. Anything else is a real failure.
      if (error && (error as { code?: string }).code !== UNIQUE_VIOLATION) {
        return { ok: false, error: PROMOTE_ERROR };
      }
    }

    promoted += 1;
  }

  return { ok: true, promoted };
}
