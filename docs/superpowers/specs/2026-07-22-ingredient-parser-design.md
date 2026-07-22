# Ingredient Parser — Design Spec (#11, Slice 1c unit 1)

- **Date:** 2026-07-22
- **Issue:** #11 — `1c: "2 cups flour" and "flour, 2c" count as one ingredient — normalization (lib, TDD)`
- **Serves:** #12 (recipe ingestion + manual editor), #14 (grocery roll-up/dedupe)
- **Authorities:** SPEC.md (Recipe Ingestion Mechanics, Testing Strategy), ADR 0003
  (ingredient dedupe rule), TEAM.md (strict test-first DoD)
- **Status:** Approved (Jon, 2026-07-22) — ready for implementation plan

## Purpose

A framework-free parser in `lib/` that turns a raw ingredient string — from JSON-LD
extraction (#12) or hand entry — into structured, mergeable data:
`{quantity, unit, name, rawText}`. This is the app's riskiest logic and is built
**strict test-first**. It has no user-facing surface of its own; it exists so the
grocery list a parent shops from (#14) is correct.

Nothing is ever lost: `rawText` is preserved on every parse path, and every parsed
line remains user-correctable downstream (#12).

## Scope decisions (settled in brainstorming)

### No external food database
The hard sub-problem — telling a *unit* from a *name* (`2 cups flour` vs `2 eggs`) —
is solved with a **small, closed, hand-owned measurement-unit table**, not an
external service. There are two vocabularies in an ingredient line:

| Vocabulary | Size | Source |
|---|---|---|
| Measurement units (cup, tbsp, g, ml, clove, can…) | ~30–40, **closed** | A constant we own |
| Ingredient names (flour, lime, gochujang…) | effectively **infinite, open** | what USDA/Nutritionix sell |

MVP dedupe is a **normalized-string match** (ADR 0003), *not* semantic ingredient
identity, so the open vocabulary — the only thing an external partner (USDA,
Nutritionix) would provide — is never needed. Avoiding it also avoids a network
dependency, key management, latency, and a `third-party-security-review` for zero
MVP benefit. Revisit only if a future feature needs true ingredient identity.

### The unit/name rule (Jon's fallback)
- If the token after the quantity is in the measurement-unit table → it is the `unit`.
- Otherwise there is **no measurement unit**: `unit = null`, and the ingredient is a
  **count** item (`2 eggs` → `quantity: 2, unit: null, name: "eggs"` — `name` stays
  display-form; `normalizeName("eggs")` yields the `egg` dedupe key at #14 time).

We store `unit = null` for count items rather than duplicating the name into the unit
(Jon's CMS used `unit = "egg"`). Rationale: dedupe is identical either way (count
items merge on `normalizeName(name)`), but `null` is non-redundant and lets the
**merged** grocery line render from `quantity + name` = `5 eggs` without a special
case. (A merged line's quantity — e.g. `5` from `2 eggs` + `3 eggs` — exists in no
single `rawText`, so merged lines are *always* composed from structured fields; this
is the whole reason the parser exists.)

### Prep modifiers stay OUT of unit/dedupe
A recipe CMS may model `juice of 3 limes` as `unit = "lime (juiced)"`. This app's #1
consumer is the **shopping list**, where `1 lime` and `juice of 2 limes` should merge
to **`3 limes`** — you buy the lime regardless of prep. So prep is never folded into
`unit` or the dedupe key. (Prep as its own field is a deliberate *future* extension —
see below — not MVP.)

### Metric in, no conversion
`g/kg/ml/l` are just more closed-set unit entries. `200 g flour` parses fine. Per
ADR 0003 there is **no unit conversion** in MVP, so `200 g flour` and `1 cup flour`
parse correctly and simply list **separately** (different units don't merge). This is
ADR-sanctioned behavior, not a gap.

### Field model: 4 fields, extension-shaped
Output exactly the fields the AC and the `ingredients` DB table commit to
(`quantity, unit, name, raw_text`). `garnish` / `optional` / prep-modifier are
**anticipated extensions** (see below): nothing in MVP consumes them and they'd force
schema (#13/#7) + editor (#12) changes outside this ticket. The output *type* is
shaped so they can be added later without a rewrite. HTML-annotation-style
raw-text→field mapping is a **#12 (editor)** concern, not the parser's.

## API surface

`lib/recipes/ingredient.ts` (+ colocated `ingredient.test.ts`), following the
`lib/`-domain-folder pattern. #12's JSON-LD ingest lands beside it; #14's grocery
roll-up imports `normalizeName` from here.

```ts
export type ParsedIngredient = {
  /** Numeric amount, or null when there is no leading quantity ("salt to taste"). */
  quantity: number | null;
  /** Canonical measurement unit if recognized, else null (count items, unmeasured). */
  unit: string | null;
  /** Cleaned display form, original case ("all-purpose flour"). NOT normalized. */
  name: string;
  /** Verbatim input — preserved on every path, never lost. */
  rawText: string;
};

/** Parse one raw ingredient line into structured, mergeable fields. Pure; no I/O. */
export function parseIngredient(raw: string): ParsedIngredient;

/**
 * The dedupe key for #14: trim / lowercase / collapse-whitespace / singularize.
 * Applied at dedupe time, so `name` stays display-form and the list reads nicely.
 */
export function normalizeName(name: string): string;
```

- `name` is stored **display-form** (trimmed, whitespace-collapsed, original case).
  Normalization to the match key happens at dedupe time via `normalizeName`, per the
  AC ("name normalization exposed for the dedupe step").
- `rawText` is camelCase in the lib; it maps to the `raw_text` column at the DB
  boundary (same convention as `createdAt` elsewhere).
- Units are canonicalized *inside* `parseIngredient` (e.g. `cups → cup`), so #14
  compares stored `unit` values directly (exact match) — no separately-exported unit
  normalizer is needed.

## Parse pipeline (pure, left-to-right)

1. **Preserve** `rawText` = input. Work on a trimmed / whitespace-collapsed copy.
2. **Strip leading quantity** → `quantity` (see quantity grammar). Remainder continues.
3. **Peek the next token** against the canonical unit table (synonyms folded). Hit →
   `unit` = canonical form, consume the token. Miss → `unit = null`.
4. **Remainder** → `name` (cleaned display form).
5. If step 2 found no quantity, `quantity = null` (e.g. `salt to taste`); the whole
   remainder is the `name`.

### Quantity grammar
Recognized leading forms:
- integer (`2`), decimal (`0.5`, `1.25`)
- ASCII fraction (`1/2`, `3/4`)
- vulgar fraction (`½ ¼ ¾ ⅓ ⅔ ⅛ …`) → numeric value
- mixed number (`1½`, `1 1/2`) → sum
- **range** (`2-3`, `2 to 3`) → take the **high end** (never under-buy); `rawText`
  still preserves the original range verbatim.

Anything that does not begin with a recognized quantity form → `quantity = null`, and
the line is treated as name-only (unit peek still applies to the first token, but an
unrecognized first token just becomes part of the name).

### Unit table
A single exported/internal constant: canonical unit → set of synonyms. Covers common
cooking units across systems, e.g.:
- volume (imperial/US): `tsp` (teaspoon), `tbsp` (tablespoon, `T`), `cup`, `pint`,
  `quart`, `gallon`, `fl oz`
- weight (imperial/US): `oz` (ounce), `lb` (pound)
- metric: `g` (gram), `kg`, `ml`, `l`
- countable/other: `clove`, `can`, `package`/`pkg`, `stick`, `pinch`, `dash`, `slice`

Matching is case-insensitive and synonym-folded; the **canonical** form is what gets
stored. The exact contents are finalized during implementation (test-driven from real
recipe lines); the table lives in one place and is trivially extended.

### Name singularization
`normalizeName` singularizes with a **small deterministic rule set** + a tiny
irregular-exceptions map (`tomatoes → tomato`, `leaves → leaf`, `-ies → -y`,
`-oes → -o`, trailing `-s`), **no NLP dependency**. Naïve strip-`s` is wrong on
`-ies/-oes`; a full inflection library is overkill and a security-review surface. The
exception map lives in one place and grows as real data demands.

## Known limitation (deferred, captured)
The `"<prep> of <N> <name>"` form (`juice of 3 limes`, `zest of 1 lemon`) does **not**
begin with a quantity, so it parses as `quantity = null, unit = null,
name = "juice of 3 limes"` with full `rawText` retained — **safe (no data loss), but
less structured**. Deferred to keep #11 on the dominant `N unit name` grammar;
revisit in #12 if real recipes show it often. Tracked as a known limitation, not a bug.

## Anticipated extensions (not built now)
Shape the `ParsedIngredient` type and the pipeline so these slot in without a rewrite:
- `garnish: boolean`, `optional: boolean` — detectable from trailing `(optional)` /
  `for garnish` / `to serve`; deferred until schema + editor consume them.
- prep modifier (`juiced`, `chopped`, `minced`) as its own field — kept out of
  `unit`/dedupe by design.

## Testing strategy (strict test-first — TEAM.md DoD)
Write a **parse-table** spec first, watch it fail, then implement. Cases:
- The 6 AC rows verbatim (incl. `1½ cups all-purpose flour` → the exact expected
  struct; `salt to taste` → null quantity/unit; `normalizeName` exposed).
- Quantity matrix: integer / decimal / ASCII fraction / vulgar fraction / mixed /
  range (asserts high-end).
- Unit matrix: canonical + each synonym → canonical; metric units; unmeasured
  (`2 eggs` → `unit: null`).
- Count-item dedupe path: `2 eggs` + `3 eggs` normalize/merge to one name.
- `rawText` preserved on **every** path (quantity, no-quantity, range, unknown).
- `normalizeName`: trim / lowercase / collapse-ws / singularize incl. irregulars.
- Deferred form: `juice of 3 limes` → null quantity, full `rawText` (asserts the
  documented limitation, so it's a conscious contract not an accident).

Pure functions, zero I/O, no Supabase — exhaustively table-testable. Lint/typecheck
clean; PR linked to #11; QA verifies the parse table; PO accepts.

## Out of scope (this ticket)
- Unit conversion (ADR 0003 — never in MVP).
- Semantic ingredient identity / external food DBs.
- Persistence, JSON-LD extraction (#12), grocery roll-up/dedupe consumption (#14),
  any UI/editor.
