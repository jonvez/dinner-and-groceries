/**
 * Pure orchestration for the recipe-ingest flow (issue #12c, Slice 1c): fetching
 * + extracting a preview from a pasted URL, and persisting the edited result to
 * the library through the shared atomic `saveRecipe` (#272). Like the board's `actions-core.ts`, these take injected
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
import { saveRecipe } from "@/lib/recipes/save-recipe";
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

// ---------------------------------------------------------------------------
// Save the edited result to the library (one atomic save_recipe call)
// ---------------------------------------------------------------------------

export type SaveIngestedDishInput = {
  title: string;
  /** Raw form value. "" means by-hand (no source) — never "ingested" for analytics. */
  sourceUrl: string;
  /** Raw form value (extracted OR hand-typed) — scheme-validated before persist. */
  imageUrl: string;
  /** Raw numeric text from the editor. */
  prepMinutes: string;
  cookMinutes: string;
  totalMinutes: string;
  /** Raw servings text ("6 to 8"); blank = unknown. */
  servings: string;
  /** Raw textarea content — one ingredient per line, "## Section" groups. */
  ingredientsText: string;
  /** Raw textarea content — the method as markdown (see lib/recipes/method-parse.ts). */
  methodText: string;
};

export type SaveIngestedDishResult =
  | {
      ok: true;
      dishId: string;
      /** The SCRUBBED source URL (null when absent or unsafe). Callers gate the
       *  `recipe_ingested` analytics event on this post-scrub truth, never on
       *  the raw form input. */
      sourceUrl: string | null;
    }
  | { ok: false; error: string };

function parseMinutesField(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * The add form's save: a thin adapter from form strings to the shared,
 * atomic `saveRecipe` (lib/recipes/save-recipe.ts, #272). The dish, its
 * ingredients and its method land in ONE `save_recipe` transaction, or none of
 * it does — there is no half-saved recipe and no partial-success state.
 * Household and author are derived in SQL from the verified session, so this
 * sends neither. URL scrubbing, ingredient parsing (with sections) and method
 * parsing all live in `saveRecipe`; nothing here reimplements them.
 */
export async function saveIngestedDish(
  supabase: Pick<DbClient, "from" | "rpc">,
  input: SaveIngestedDishInput,
): Promise<SaveIngestedDishResult> {
  const result = await saveRecipe(supabase, {
    id: null,
    title: input.title,
    sourceUrl: input.sourceUrl,
    imageUrl: input.imageUrl,
    prepMinutes: parseMinutesField(input.prepMinutes),
    cookMinutes: parseMinutesField(input.cookMinutes),
    totalMinutes: parseMinutesField(input.totalMinutes),
    servings: input.servings,
    ingredientsText: input.ingredientsText,
    methodText: input.methodText,
  });
  if (!result.ok) return result;
  // The same scrub saveRecipe applied, so the event gate matches what was stored.
  return { ok: true, dishId: result.dishId, sourceUrl: safeHttpUrl(input.sourceUrl) };
}
