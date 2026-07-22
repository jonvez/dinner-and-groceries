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

/** Unicode vulgar fractions → numeric value. */
const VULGAR_FRACTIONS: Record<string, number> = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4,
  "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};
const VULGAR_CLASS = "½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";

/**
 * Strip a leading quantity from `text`. Returns the numeric value (or null when the
 * line has no leading amount) and the left-trimmed remainder. A RANGE ("2-3", "2 to
 * 3") resolves to the HIGH end so a grocery list never under-buys; `rawText`
 * upstream still preserves the original range verbatim.
 */
export function parseQuantity(text: string): { quantity: number | null; rest: string } {
  const s = text.trimStart();

  // Range: high end wins.
  const range = s.match(
    new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:-|–|to)\\s*(\\d+(?:\\.\\d+)?)\\b(.*)$`),
  );
  if (range) {
    return { quantity: Math.max(parseFloat(range[1]), parseFloat(range[2])), rest: range[3].trimStart() };
  }

  // Mixed: integer + (ascii or vulgar) fraction, attached or spaced.
  const mixed = s.match(new RegExp(`^(\\d+)\\s*(?:(\\d+)\\/(\\d+)|([${VULGAR_CLASS}]))(.*)$`));
  if (mixed) {
    const whole = parseInt(mixed[1], 10);
    const frac = mixed[2] ? parseInt(mixed[2], 10) / parseInt(mixed[3], 10) : VULGAR_FRACTIONS[mixed[4]];
    return { quantity: whole + frac, rest: mixed[5].trimStart() };
  }

  // Standalone vulgar fraction.
  const vulgar = s.match(new RegExp(`^([${VULGAR_CLASS}])(.*)$`));
  if (vulgar) return { quantity: VULGAR_FRACTIONS[vulgar[1]], rest: vulgar[2].trimStart() };

  // Standalone ascii fraction.
  const frac = s.match(/^(\d+)\/(\d+)\b(.*)$/);
  if (frac) return { quantity: parseInt(frac[1], 10) / parseInt(frac[2], 10), rest: frac[3].trimStart() };

  // Plain integer or decimal.
  const num = s.match(/^(\d+(?:\.\d+)?)\b(.*)$/);
  if (num) return { quantity: parseFloat(num[1]), rest: num[2].trimStart() };

  // No leading quantity.
  return { quantity: null, rest: text.trim() };
}

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
