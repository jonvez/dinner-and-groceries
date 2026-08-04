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

import { extractRecipeJsonLd } from "@/lib/recipes/recipe-jsonld";
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
