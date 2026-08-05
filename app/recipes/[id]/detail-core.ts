/**
 * Read-only recipe detail loader (issue #12c, kickoff resolution 3). Pure over
 * an injected Supabase-like client (unit-tested without a live DB), exactly like
 * `app/recipes/new/ingest-core.ts`. In production the cookie-session client runs
 * as the signed-in user, so RLS + `public.current_household_id()` scope the read
 * to the caller's household: a dish id from ANOTHER household simply returns no
 * row, indistinguishable from a bad id — both yield `null`, and the page renders
 * the not-found boundary. There is no service-role key on this path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { safeHttpUrl } from "@/lib/web/safe-url";

type DbClient = SupabaseClient<Database>;

export type RecipeDetail = {
  id: string;
  title: string;
  imageUrl: string | null;
  sourceUrl: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  ingredientLines: string[];
};

export async function loadRecipeDetail(
  supabase: Pick<DbClient, "from">,
  id: string,
): Promise<RecipeDetail | null> {
  const { data: dish } = await supabase
    .from("dishes")
    .select(
      "id, title, image_url, source_url, prep_minutes, cook_minutes, total_minutes",
    )
    .eq("id", id)
    .maybeSingle();

  // No row = bad id OR another household's recipe (RLS). A malformed (non-uuid)
  // id comes back as a PostgREST error, not a throw — `maybeSingle` yields
  // `data: null` here too, so the page 404s instead of crashing.
  if (!dish) return null;

  const { data: ingredients } = await supabase
    .from("ingredients")
    .select("raw_text")
    .eq("dish_id", id)
    .order("position", { ascending: true });

  return {
    id: dish.id,
    title: dish.title,
    // Defense-in-depth: re-scrub the stored URLs at the read boundary before
    // they reach an <img src>/<a href> (matching app/board/proposal-pool.tsx).
    // Every current write path already scrubs via safeHttpUrl, so valid URLs
    // pass through unchanged and nulls stay null — but any future unscrubbed
    // write path (import, seed, backfill) can't turn into stored XSS here.
    imageUrl: safeHttpUrl(dish.image_url),
    sourceUrl: safeHttpUrl(dish.source_url),
    prepMinutes: dish.prep_minutes,
    cookMinutes: dish.cook_minutes,
    totalMinutes: dish.total_minutes,
    ingredientLines: (ingredients ?? []).map((row) => row.raw_text),
  };
}
