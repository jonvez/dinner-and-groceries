/**
 * Framework-free ingredient parser (issue #11, Slice 1c). Turns a raw ingredient
 * line — from JSON-LD extraction (#12) or hand entry — into structured, mergeable
 * data. Pure: no I/O, no Supabase. `rawText` is preserved on every path so nothing
 * is lost and every line stays user-correctable downstream (#12).
 *
 * Dedupe (#14) is a normalized-STRING match (ADR 0003), never semantic identity —
 * which is why a small closed unit table, not an external food database, is all we
 * need. See docs/superpowers/specs/2026-07-22-ingredient-parser-design.md.
 *
 * #170 — pasted lists. Real input arrives with the source's list marker attached
 * ("- 2 cups flour", "▢ 1 tbsp olive oil", "1. 2 cups flour"). Every marker is
 * stripped BEFORE quantity parsing, otherwise the quantity patterns miss and the
 * whole line becomes the `name` — which puts the amount inside the dedupe key and
 * silently defeats the roll-up. Two decisions recorded there:
 *
 *   - A parenthetical PACKAGE SIZE ("1 (14.5 oz) can diced tomatoes") is DROPPED,
 *     not captured: the schema has no package-size field, ADR 0003 forbids unit
 *     conversion (so `14.5 oz` cannot be multiplied into anything), and keeping it
 *     in `name` would break dedupe against the same can written any other way. The
 *     verbatim text survives in `rawText`, so nothing is lost and the line stays
 *     correctable. Only a parenthetical containing a DIGIT is treated as a package
 *     size; "(large)" and friends are descriptors and stay in the name (out of
 *     scope, per the issue).
 *   - A digit glued to its unit ("2lb pork shoulder") splits ONLY when the glued
 *     letters are a known unit, so a product code ("2x4") is never mistaken for a
 *     quantity.
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
 * A leading list marker, as pasted out of a recipe site, a note or a Word doc (#170).
 *
 * Two of these are deliberately narrower than they look:
 *   - a dash (`-`/`–`/`—`) must be FOLLOWED BY WHITESPACE, so "-2 cups flour" keeps
 *     its documented "not a quantity" behaviour and a hyphenated name is untouched;
 *   - a list number (`1.` / `1)`) must be followed by whitespace too, so the decimal
 *     in "1.5 cups flour" is never mistaken for item 1.
 * The unambiguous glyph bullets and checkboxes may be glued to the amount ("•1 tbsp").
 */
const LIST_MARKER = new RegExp(
  "^(?:" +
    "[-–—]\\s+" + // hyphen / en dash / em dash bullet
    "|[*•·▪▫▢□◦‣]\\s*" + // glyph bullets, incl. the recipe-site checkbox ▢
    "|\\[[ xX]?\\]\\s*" + // markdown-ish checkbox: [ ] / [] / [x]
    "|\\d+[.)]\\s+" + // numbered list: "1." / "1)"
    "|o\\s+" + // Word's sub-bullet, only as a standalone token
    ")",
);

/**
 * Remove any leading list marker(s) from `text` and left-trim (#170). Markers nest
 * in the wild ("- [ ] 2 cups flour"), so this strips repeatedly — bounded, so a
 * pathological line can never spin.
 */
export function stripListMarker(text: string): string {
  let s = text.trimStart();
  for (let i = 0; i < 4; i++) {
    const stripped = s.replace(LIST_MARKER, "");
    if (stripped === s) break;
    s = stripped.trimStart();
  }
  return s;
}

/**
 * Strip a leading list marker and quantity from `text`. Returns the numeric value
 * (or null when the line has no leading amount) and the left-trimmed remainder. A
 * RANGE ("2-3", "2 to 3") resolves to the HIGH end so a grocery list never
 * under-buys; `rawText` upstream still preserves the original line verbatim.
 */
export function parseQuantity(text: string): { quantity: number | null; rest: string } {
  const s = stripListMarker(text);

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

  // Digit glued to its unit ("2lb pork shoulder"): split ONLY when the glued
  // letters are a known unit, so a product code ("2x4 lumber") is left alone.
  const glued = s.match(/^(\d+(?:\.\d+)?)([a-zA-Z]+)\b(.*)$/);
  if (glued && matchUnit(glued[2])) {
    return { quantity: parseFloat(glued[1]), rest: `${glued[2]}${glued[3]}`.trimStart() };
  }

  // Plain integer or decimal.
  const num = s.match(/^(\d+(?:\.\d+)?)\b(.*)$/);
  if (num) return { quantity: parseFloat(num[1]), rest: num[2].trimStart() };

  // No leading quantity.
  return { quantity: null, rest: s.trimEnd() };
}

/**
 * Closed measurement-unit table: synonym/plural → canonical form. The ONLY
 * "dictionary" in the parser (ADR 0003 — dedupe is exact-normalized-unit match, no
 * conversion). Single-letter ambiguous abbreviations (`c`, `T`/`t`) are deliberately
 * omitted to avoid false matches; unambiguous metric single letters (`g`, `l`) are
 * kept. Extend here as real recipe lines demand.
 */
const UNIT_SYNONYMS: Record<string, string> = {
  teaspoon: "tsp", teaspoons: "tsp", tsp: "tsp", tsps: "tsp",
  tablespoon: "tbsp", tablespoons: "tbsp", tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp",
  cup: "cup", cups: "cup",
  pint: "pint", pints: "pint", pt: "pint",
  quart: "quart", quarts: "quart", qt: "quart",
  gallon: "gallon", gallons: "gallon", gal: "gallon",
  "fl oz": "fl oz", "fluid ounce": "fl oz", "fluid ounces": "fl oz", floz: "fl oz",
  ounce: "oz", ounces: "oz", oz: "oz",
  pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
  gram: "g", grams: "g", g: "g",
  kilogram: "kg", kilograms: "kg", kg: "kg",
  milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml", ml: "ml",
  liter: "l", liters: "l", litre: "l", litres: "l", l: "l",
  clove: "clove", cloves: "clove",
  can: "can", cans: "can",
  package: "package", packages: "package", pkg: "package", pkgs: "package",
  stick: "stick", sticks: "stick",
  pinch: "pinch", pinches: "pinch",
  dash: "dash", dashes: "dash",
  slice: "slice", slices: "slice",
};

/**
 * Canonical unit for `token`, or null if it is not a known measurement unit.
 * Case-insensitive; folds a single trailing period. Multi-word units (e.g. "fl oz")
 * are matched by passing the joined two-word string.
 */
export function matchUnit(token: string): string | null {
  const key = token.trim().toLowerCase().replace(/\.$/, "");
  return UNIT_SYNONYMS[key] ?? null;
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

/**
 * A parenthetical PACKAGE SIZE straight after the quantity ("1 (14.5 oz) can diced
 * tomatoes"). Requires a digit inside the parens: that is what tells a package size
 * from a descriptor ("(large)"), which stays in the name (out of scope for #170).
 */
const PACKAGE_SIZE = /^\((?=[^)]*\d)[^)]*\)\s*/;

/**
 * Parse one raw ingredient line into structured, mergeable fields. Pure; no I/O.
 * Pipeline: preserve rawText → strip a leading list marker + quantity → (only if a
 * quantity was found) drop a parenthetical package size, then match a unit (two-word
 * before one-word) → remainder is the display name. A measurement unit with no
 * preceding quantity is meaningless, so unquantified lines get unit=null and the
 * whole remainder as the name.
 */
export function parseIngredient(raw: string): ParsedIngredient {
  const rawText = raw;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  const { quantity, rest } = parseQuantity(collapsed);

  if (quantity === null) {
    return { quantity: null, unit: null, name: rest, rawText };
  }

  // Package size is dropped, not captured — see the module docstring (#170).
  const afterPackage = rest.replace(PACKAGE_SIZE, "");
  const tokens = afterPackage.length ? afterPackage.split(" ") : [];
  let unit: string | null = null;
  let nameTokens = tokens;

  if (tokens.length >= 2) {
    const two = matchUnit(`${tokens[0]} ${tokens[1]}`);
    if (two) {
      unit = two;
      nameTokens = tokens.slice(2);
    }
  }
  if (unit === null && tokens.length >= 1) {
    const one = matchUnit(tokens[0]);
    if (one) {
      unit = one;
      nameTokens = tokens.slice(1);
    }
  }

  return { quantity, unit, name: nameTokens.join(" "), rawText };
}
