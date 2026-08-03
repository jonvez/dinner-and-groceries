/**
 * Framework-free schema.org/Recipe extractor (issue #12a, Slice 1c). Takes raw
 * HTML as a STRING (decoupled from the fetcher so a saved-HTML paste, #77, reuses
 * it) and returns a structured recipe, or null when no Recipe JSON-LD is present.
 * Pure: no network, no DOM, no Supabase. Ingredient lines are returned RAW —
 * normalization (parseIngredient) happens on save in #12c.
 *
 * Scope (spec 12a): JSON-LD only (no microdata/RDFa); handles a single object, an
 * array, and the @graph wrapper; @type as string or array; recipeIngredient with a
 * legacy `ingredients` fallback; ISO-8601 durations → minutes; image as string,
 * {url}, or array. Takes the FIRST Recipe found.
 */

export type ExtractedRecipe = {
  title: string | null;
  imageUrl: string | null;
  ingredientLines: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
};

// Only the time components (H/M/S) are counted; any date part (Y/M/W/D) is ignored
// — recipe durations are sub-day in practice.
const ISO_DURATION_RE =
  /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function isoDurationToMinutes(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const match = iso.trim().match(ISO_DURATION_RE);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) {
    return null;
  }
  return (
    (hours ? Number(hours) * 60 : 0) +
    (minutes ? Number(minutes) : 0) +
    (seconds ? Math.round(Number(seconds) / 60) : 0)
  );
}

const JSONLD_SCRIPT_RE =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Expand a parsed JSON-LD value into candidate nodes (arrays + @graph inlined). */
function flattenNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenNodes);
  if (value && typeof value === "object") {
    const graph = (value as Record<string, unknown>)["@graph"];
    if (Array.isArray(graph)) return [value, ...graph.flatMap(flattenNodes)];
    return [value];
  }
  return [value];
}

export function collectJsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const match of html.matchAll(JSONLD_SCRIPT_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue; // one malformed block must not sink the whole page
    }
    for (const node of flattenNodes(parsed)) {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        nodes.push(node as Record<string, unknown>);
      }
    }
  }
  return nodes;
}
