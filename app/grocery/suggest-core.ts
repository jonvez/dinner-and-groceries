/**
 * Matching the family's staples as they type (issue #148).
 *
 * The Things import put 492 staples in the catalog, which made the one-tap chip
 * row unusable — 492 chips is not a shortcut, it is a wall. Typing is the way
 * in now, and this is the matcher behind it.
 *
 * Pure and framework-free so the ranking is exhaustively testable without a
 * DOM. The whole catalog is already in the browser (`loadGroceryList` ships it
 * with the page), so this runs locally on every keystroke with no network and
 * no query cost — which is exactly why there is no "wait for 3 characters"
 * threshold here. That rule exists to avoid *server* work on a large corpus;
 * with a local list of a few hundred, the 5-result cap does the noise control
 * instead. NN/g's mobile-input checklist asks the opposite question — "can you
 * make suggestions based on the FIRST letters typed?" — and that is what this
 * supports.
 *
 * References: nngroup.com mobile-input-checklist and site-search-suggestions;
 * GOV.UK search-autocomplete (5 suggestions, "reduce cognitive load"); Baymard
 * (4–8 on mobile).
 */

import type { CatalogRow } from "./list-core";

/**
 * GOV.UK caps its search autocomplete at 5 "to reduce cognitive load and
 * prevent unnecessary scrolling"; Baymard puts the mobile band at 4–8. This
 * screen is used one-handed in an aisle, so take the low end.
 */
export const MAX_SUGGESTIONS = 5;

/** One character is enough — see the header on why there is no 3-char rule. */
export const MIN_QUERY_LENGTH = 1;

/**
 * A name split around the matched text, so the caller can bold the part the
 * user typed. NN/g's rule is conditional: highlight the *suggestion* when it
 * merely appends to the query, but highlight the *query* when the match can
 * land anywhere in the name. Matches land anywhere here, so the query is what
 * gets emphasised — and the split is done here, where the match index is
 * already known, rather than re-derived in JSX.
 */
export type NameSegments = {
  before: string;
  /** The matched run, in the STAPLE's original casing, never the typed casing. */
  match: string;
  after: string;
};

export type StapleSuggestion = {
  id: string;
  name: string;
  defaultUnit: string | null;
  segments: NameSegments;
};

/**
 * Rank buckets, best first. A staple whose name *starts* with what you typed is
 * almost always the one you meant; a match in the middle of a longer name is a
 * weaker signal but still worth offering ("oil" should find "olive oil").
 */
const RANK_PREFIX = 0;
const RANK_WORD_START = 1;
const RANK_ANYWHERE = 2;

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Which bucket this match falls in, or null when the name does not match. */
function rankOf(haystack: string, needle: string): number | null {
  const index = haystack.indexOf(needle);
  if (index === -1) return null;
  if (index === 0) return RANK_PREFIX;
  // A match immediately after a space is the start of a word — "oil" in
  // "olive oil" beats "oil" in "broiler".
  return haystack[index - 1] === " " ? RANK_WORD_START : RANK_ANYWHERE;
}

/**
 * The staples worth offering for `query`, best first, capped.
 *
 * Returns nothing for a query shorter than `MIN_QUERY_LENGTH` (including an
 * empty or whitespace-only one) — an empty field is not a search, and showing
 * "the first five staples alphabetically" would be the 492-chip problem again
 * in miniature.
 *
 * Ties break by `addedCount` descending, then name, so the ordering is stable
 * and becomes more useful as real trips accumulate. Today every imported staple
 * has the same count, so ties fall through to alphabetical.
 */
export function suggestStaples(
  query: string,
  catalog: CatalogRow[],
  { limit = MAX_SUGGESTIONS }: { limit?: number } = {},
): StapleSuggestion[] {
  const needle = normalize(query);
  if (needle.length < MIN_QUERY_LENGTH) return [];

  const scored: { rank: number; row: CatalogRow; index: number }[] = [];
  for (const row of catalog) {
    const haystack = normalize(row.name);
    const rank = rankOf(haystack, needle);
    if (rank === null) continue;
    scored.push({ rank, row, index: haystack.indexOf(needle) });
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      (b.row.addedCount ?? 0) - (a.row.addedCount ?? 0) ||
      a.row.name.localeCompare(b.row.name),
  );

  return scored.slice(0, limit).map(({ row, index }) => ({
    id: row.id,
    name: row.name,
    defaultUnit: row.defaultUnit,
    segments: splitOnMatch(row.name, index, needle.length),
  }));
}

/**
 * Split the DISPLAY name at the match. The index came from the normalized
 * string, so this only lines up while normalization preserves length — it
 * collapses runs of whitespace, so recompute against the trimmed display name
 * rather than trusting the index blindly. A mismatch degrades to "no
 * highlight", never to a corrupted name.
 */
function splitOnMatch(name: string, index: number, length: number): NameSegments {
  const display = name.trim();
  const found = display.toLowerCase().indexOf(
    normalize(display).slice(index, index + length),
  );
  if (found === -1) return { before: display, match: "", after: "" };
  return {
    before: display.slice(0, found),
    match: display.slice(found, found + length),
    after: display.slice(found + length),
  };
}
