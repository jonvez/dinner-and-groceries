/**
 * Pure orchestration for the recipe-ingest flow (issue #12c, Slice 1c): fetching
 * + extracting a preview from a pasted URL, and (Task 2) persisting the edited
 * result to the library. Like the board's `actions-core.ts`, these take injected
 * collaborators (a fetch function / a Supabase-like client) so they are
 * unit-tested WITHOUT a live network call or a live DB. The thin Server Actions
 * (`actions.ts`) supply the real `safeFetchHtml` + cookie-session client and
 * resolve identity from the verified session.
 *
 * Security (design of record, #12c):
 *   - `fetchRecipePreview` calls ONLY the injected fetcher (production: the
 *     SSRF-guarded `safeFetchHtml`, #76) — this module never opens a socket
 *     itself.
 *   - Every URL that could reach storage — the pasted `sourceUrl` AND the
 *     extracted/edited `imageUrl` — is scrubbed through `safeHttpUrl` before it
 *     is returned to the client OR persisted. An unsafe image URL is DROPPED
 *     (stored/shown as null); the recipe still saves (never a dead end).
 *   - Extraction failure (no JSON-LD Recipe) and fetch failure both fall back to
 *     the SAME empty, editable preview shape — the by-hand editor is never a
 *     distinct code path the UI has to special-case.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { extractRecipeJsonLd } from "@/lib/recipes/recipe-jsonld";
import { parseIngredient } from "@/lib/recipes/ingredient";
import { safeHttpUrl } from "@/lib/web/safe-url";
import type { SafeFetchResult } from "@/lib/http/safe-fetch";

// ---------------------------------------------------------------------------
// Fetch + extract a preview (no DB write — Save is a separate, explicit step)
// ---------------------------------------------------------------------------

export type RecipePreviewFields = {
  title: string;
  imageUrl: string | null;
  ingredientLines: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
};

/** The shape every code path renders — extraction failure is never a dead end. */
export const EMPTY_RECIPE_PREVIEW: RecipePreviewFields = {
  title: "",
  imageUrl: null,
  ingredientLines: [],
  prepMinutes: null,
  cookMinutes: null,
  totalMinutes: null,
};

export type FetchHtml = (url: string) => Promise<SafeFetchResult>;

export type FetchPreviewResult =
  | { ok: true; sourceUrl: string; preview: RecipePreviewFields }
  | { ok: false; notice: string; preview: RecipePreviewFields };

/**
 * Fetch `rawUrl` through the injected (SSRF-guarded, in production) `fetchHtml`,
 * extract a schema.org/Recipe, and return an editable preview. Never throws:
 * every failure — a bad scheme, a blocked/unreachable/non-HTML fetch, or a page
 * with no Recipe JSON-LD — resolves to `{ ok: false }` carrying the SAME empty,
 * editable preview shape, so the caller always has a form to render.
 */
export async function fetchRecipePreview(
  fetchHtml: FetchHtml,
  rawUrl: string,
): Promise<FetchPreviewResult> {
  const url = safeHttpUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      notice: "Enter a valid http(s) recipe link, or add it by hand below.",
      preview: EMPTY_RECIPE_PREVIEW,
    };
  }

  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    return {
      ok: false,
      notice: "We couldn't fetch that page. Check the link, or add the recipe by hand below.",
      preview: EMPTY_RECIPE_PREVIEW,
    };
  }

  const extracted = extractRecipeJsonLd(fetched.html);
  if (!extracted) {
    return {
      ok: false,
      notice: "We couldn't find a recipe on that page. Add it by hand below.",
      preview: EMPTY_RECIPE_PREVIEW,
    };
  }

  return {
    ok: true,
    sourceUrl: url,
    preview: {
      title: extracted.title ?? "",
      // Scrub BEFORE this ever reaches the client — a page's JSON-LD `image` is
      // untrusted content (a `javascript:` URL here would otherwise round-trip
      // straight into the editor's Image URL field).
      imageUrl: safeHttpUrl(extracted.imageUrl),
      ingredientLines: extracted.ingredientLines,
      prepMinutes: extracted.prepMinutes,
      cookMinutes: extracted.cookMinutes,
      totalMinutes: extracted.totalMinutes,
    },
  };
}

type DbClient = SupabaseClient<Database>;
type IngredientInsert = Database["public"]["Tables"]["ingredients"]["Insert"];

// ---------------------------------------------------------------------------
// Save the edited result to the library (dish + ingredients)
// ---------------------------------------------------------------------------

export type SaveIngestedDishInput = {
  /** From the caller's VERIFIED session — never request input. */
  householdId: string;
  /** From the caller's VERIFIED session — never request input. */
  createdBy: string;
  title: string;
  /** Raw form value. "" means by-hand (no source) — never "ingested" for analytics. */
  sourceUrl: string;
  /** Raw form value (extracted OR hand-typed) — scheme-validated before persist. */
  imageUrl: string;
  /** Raw numeric text from the editor. */
  prepMinutes: string;
  cookMinutes: string;
  totalMinutes: string;
  /** Raw textarea content — one ingredient per line. */
  ingredientsText: string;
};

export type SaveIngestedDishResult =
  | { ok: true; dishId: string; ingredientsSaved: boolean }
  | { ok: false; error: string };

function parseMinutesField(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * One ingredient row per non-blank line, in order. `name` is the parser's
 * display name, falling back to the verbatim line when parsing yields nothing
 * (e.g. a bare quantity like "2") — the `name` column is NOT NULL + non-empty
 * (12b), so a fallback is required, never optional.
 */
export function ingredientRowsFromText(
  ingredientsText: string,
  householdId: string,
  dishId: string,
): IngredientInsert[] {
  return ingredientsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, position) => {
      const parsed = parseIngredient(line);
      const name = parsed.name.trim() === "" ? parsed.rawText.trim() : parsed.name;
      return {
        household_id: householdId,
        dish_id: dishId,
        name,
        quantity: parsed.quantity,
        unit: parsed.unit,
        raw_text: parsed.rawText,
        position,
      };
    });
}

/**
 * Best-effort, non-atomic save (accepted seam — see module doc): insert the
 * dish, then insert its ingredients as one statement. A dish-saved /
 * ingredients-failed outcome still returns `ok: true` with
 * `ingredientsSaved: false` — the dish is real and editable; nothing is lost
 * except the ingredient rows, which the caller surfaces as a soft notice, not
 * an error. TODO (not built, tracked in the design doc): fold both writes into
 * a single SECURITY INVOKER RPC for true atomicity if this ever bites.
 */
export async function saveIngestedDish(
  supabase: Pick<DbClient, "from">,
  input: SaveIngestedDishInput,
): Promise<SaveIngestedDishResult> {
  const title = input.title.trim();
  if (title === "") {
    return { ok: false, error: "Give the recipe a title." };
  }

  // Scheme-validate every URL that could reach storage. Unlike a user-typed
  // optional field elsewhere in the app, these are DROPPED (not rejected with
  // an error) on failure — an unsafe image/source URL must never block an
  // otherwise-valid save (design doc error-handling table).
  const sourceUrl = safeHttpUrl(input.sourceUrl);
  const imageUrl = safeHttpUrl(input.imageUrl);

  const { data: dish, error: dishError } = await supabase
    .from("dishes")
    .insert({
      household_id: input.householdId,
      title,
      source_url: sourceUrl,
      image_url: imageUrl,
      prep_minutes: parseMinutesField(input.prepMinutes),
      cook_minutes: parseMinutesField(input.cookMinutes),
      total_minutes: parseMinutesField(input.totalMinutes),
      created_by: input.createdBy,
    })
    .select("id")
    .single();

  if (dishError || !dish) {
    return { ok: false, error: "We couldn't save that recipe. Please try again." };
  }

  const rows = ingredientRowsFromText(input.ingredientsText, input.householdId, dish.id);
  if (rows.length === 0) {
    return { ok: true, dishId: dish.id, ingredientsSaved: true };
  }

  const { error: ingredientsError } = await supabase.from("ingredients").insert(rows);
  return { ok: true, dishId: dish.id, ingredientsSaved: !ingredientsError };
}
