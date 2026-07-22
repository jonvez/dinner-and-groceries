/**
 * Framework-free ingredient parser (issue #11, Slice 1c). Turns a raw ingredient
 * line — from JSON-LD extraction (#12) or hand entry — into structured, mergeable
 * data. Pure: no I/O, no Supabase. `rawText` is preserved on every path so nothing
 * is lost and every line stays user-correctable downstream (#12).
 *
 * Dedupe (#14) is a normalized-STRING match (ADR 0003), never semantic identity —
 * which is why a small closed unit table, not an external food database, is all we
 * need. See docs/superpowers/specs/2026-07-22-ingredient-parser-design.md.
 */

export type ParsedIngredient = {
  /** Numeric amount, or null when there is no leading quantity ("salt to taste"). */
  quantity: number | null;
  /** Canonical measurement unit if recognized, else null (count/unmeasured items). */
  unit: string | null;
  /** Cleaned display form, original case ("all-purpose flour"). NOT normalized. */
  name: string;
  /** Verbatim input — preserved on every path, never lost. */
  rawText: string;
};

/**
 * Irregular plurals where naive strip-`s`/`ves` would be wrong. Grows as real data
 * demands — kept in one place.
 */
const IRREGULAR_SINGULARS: Record<string, string> = {
  leaves: "leaf",
  loaves: "loaf",
};

/** Singularize a single lowercased word (best-effort, deterministic, no NLP dep). */
function singularizeWord(word: string): string {
  if (word in IRREGULAR_SINGULARS) return IRREGULAR_SINGULARS[word];
  if (word.endsWith("ies") && word.length > 3) return word.slice(0, -3) + "y";
  if (word.endsWith("oes")) return word.slice(0, -2); // tomatoes -> tomato
  if (/(ss|ch|sh|x|z)es$/.test(word)) return word.slice(0, -2); // glasses -> glass, dishes -> dish, boxes -> box
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1); // eggs -> egg, roses -> rose
  return word;
}

/**
 * The dedupe key for #14: trim / lowercase / collapse-whitespace / singularize the
 * last word. Applied at dedupe time so stored `name` stays display-form.
 */
export function normalizeName(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (cleaned === "") return "";
  const words = cleaned.split(" ");
  words[words.length - 1] = singularizeWord(words[words.length - 1]);
  return words.join(" ");
}
