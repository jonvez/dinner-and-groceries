/**
 * Read-only recipe detail loader (issue #12c, kickoff resolution 3; method and
 * ingredient groups as rows since #272). Pure over an injected Supabase-like
 * client (unit-tested without a live DB), exactly like
 * `app/recipes/new/ingest-core.ts`. In production the cookie-session client runs
 * as the signed-in user, so RLS + `public.current_household_id()` scope the read
 * to the caller's household: a dish id from ANOTHER household simply returns no
 * row, indistinguishable from a bad id — both yield `null`, and the page renders
 * the not-found boundary. There is no service-role key on this path.
 *
 * The method comes from `dish_phases` / `dish_steps`. The legacy
 * `dishes.description` markdown is never read here: rows are the only truth.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { safeHttpUrl } from "@/lib/web/safe-url";

import type { MethodPhase } from "./method-types";

type DbClient = SupabaseClient<Database>;

export type IngredientGroup = {
  /** The group label ("Filling"), or null for ungrouped lines. */
  section: string | null;
  lines: string[];
};

export type RecipeDetail = {
  id: string;
  title: string;
  imageUrl: string | null;
  sourceUrl: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  servings: string | null;
  ingredientGroups: IngredientGroup[];
  /** Null when the recipe has no phases and no steps. */
  method: { phases: MethodPhase[] } | null;
};

/** Consecutive lines sharing a section form one group, in position order. */
export function groupIngredients(
  rows: readonly { raw_text: string; section: string | null }[],
): IngredientGroup[] {
  const groups: IngredientGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.section === row.section) last.lines.push(row.raw_text);
    else groups.push({ section: row.section, lines: [row.raw_text] });
  }
  return groups;
}

export async function loadRecipeDetail(
  supabase: Pick<DbClient, "from">,
  id: string,
): Promise<RecipeDetail | null> {
  const { data: dish } = await supabase
    .from("dishes")
    .select(
      "id, title, image_url, source_url, prep_minutes, cook_minutes, total_minutes, servings",
    )
    .eq("id", id)
    .maybeSingle();

  // No row = bad id OR another household's recipe (RLS). A malformed (non-uuid)
  // id comes back as a PostgREST error, not a throw — `maybeSingle` yields
  // `data: null` here too, so the page 404s instead of crashing.
  if (!dish) return null;

  const [{ data: ingredients }, { data: phases }, { data: steps }] = await Promise.all([
    supabase
      .from("ingredients")
      .select("raw_text, section")
      .eq("dish_id", id)
      .order("position", { ascending: true }),
    supabase
      .from("dish_phases")
      .select("id, title, intro")
      .eq("dish_id", id)
      .order("position", { ascending: true }),
    supabase
      .from("dish_steps")
      .select("id, phase_id, position, body, notes")
      .eq("dish_id", id)
      .order("position", { ascending: true }),
  ]);

  const phaseRows = phases ?? [];
  const stepRows = steps ?? [];
  const method =
    phaseRows.length === 0 && stepRows.length === 0
      ? null
      : {
          phases: phaseRows.map((phase) => ({
            title: phase.title,
            intro: phase.intro,
            steps: stepRows
              .filter((step) => step.phase_id === phase.id)
              .map((step) => ({
                id: step.id,
                n: step.position + 1,
                body: step.body,
                notes: step.notes,
              })),
          })),
        };

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
    servings: dish.servings,
    ingredientGroups: groupIngredients(ingredients ?? []),
    method,
  };
}
