/**
 * Recipe size limits (security review M1 on #272). `public.save_recipe` and
 * the dish_phases / dish_steps / dishes column checks enforce these in the
 * database; `saveRecipe` checks them first so a person gets a clear message
 * instead of a generic save failure. Keep the two sides in step:
 * supabase/migrations/20261111180000_recipe_steps_as_data.sql.
 *
 * The limits bound the work and storage one call can cost every household on
 * the shared server and database. 200 steps also keeps a dish well under
 * PostgREST's 1000-row page, so the detail page never silently truncates.
 */

import type { Phase } from "./method-parse";

/** `octet_length(p_recipe::text)` limit in save_recipe. */
export const MAX_PAYLOAD_BYTES = 262_144;
export const MAX_STEPS = 200;
export const MAX_PHASES = 50;
export const MAX_INGREDIENTS = 200;
/** Column checks: dish_steps.body, .notes; dish_phases.title, .intro; dishes.servings. */
export const MAX_STEP_BODY_CHARS = 4000;
export const MAX_STEP_NOTES = 50;
export const MAX_PHASE_TITLE_CHARS = 200;
export const MAX_PHASE_INTRO_LINES = 50;
export const MAX_SERVINGS_CHARS = 100;

/**
 * Raw text limits for the add form's textareas (`maxLength`, UTF-16 units) and
 * checked again server-side before any parsing. Sized so typical text stays
 * well inside MAX_PAYLOAD_BYTES; the payload check is still the real bound.
 */
export const METHOD_TEXT_MAX_CHARS = 100_000;
export const INGREDIENTS_TEXT_MAX_CHARS = 30_000;

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).length;
/** Postgres `length(text)` counts characters (code points), not UTF-16 units. */
const chars = (text: string) => Array.from(text).length;
const n = (value: number) => value.toLocaleString("en-US");

/**
 * Byte length of `value` as Postgres prints it as jsonb (`::text`): JSON with
 * ", " and ": " separators. supabase-js sends JSON.stringify output, so
 * undefined object members are dropped.
 */
export function jsonbTextBytes(value: unknown): number {
  if (Array.isArray(value)) {
    const items = value.map((item) => jsonbTextBytes(item === undefined ? null : item));
    return 2 + items.reduce((sum, size) => sum + size, 0) + 2 * Math.max(0, items.length - 1);
  }
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]) => utf8Bytes(JSON.stringify(key)) + 2 + jsonbTextBytes(member));
    return 2 + members.reduce((sum, size) => sum + size, 0) + 2 * Math.max(0, members.length - 1);
  }
  return utf8Bytes(JSON.stringify(value) ?? "null");
}

/** The raw textarea text, checked before it is parsed at all. */
export function textLimitError(methodText: string, ingredientsText: string): string | null {
  if (methodText.length > METHOD_TEXT_MAX_CHARS) {
    return `The method is too long (the limit is ${n(METHOD_TEXT_MAX_CHARS)} characters).`;
  }
  if (ingredientsText.length > INGREDIENTS_TEXT_MAX_CHARS) {
    return `The ingredients list is too long (the limit is ${n(INGREDIENTS_TEXT_MAX_CHARS)} characters).`;
  }
  return null;
}

/** The parsed recipe, checked against every count and column limit. */
export function recipeLimitError(recipe: {
  phases: readonly Phase[];
  ingredientCount: number;
  servings: string | null;
}): string | null {
  const { phases } = recipe;
  if (recipe.ingredientCount > MAX_INGREDIENTS) {
    return `A recipe can have at most ${MAX_INGREDIENTS} ingredients (this one has ${recipe.ingredientCount}).`;
  }
  if (phases.length > MAX_PHASES) {
    return `A method can have at most ${MAX_PHASES} sections (this one has ${phases.length}).`;
  }
  const stepCount = phases.reduce((sum, phase) => sum + phase.steps.length, 0);
  if (stepCount > MAX_STEPS) {
    return `A method can have at most ${MAX_STEPS} steps (this one has ${stepCount}).`;
  }
  for (const phase of phases) {
    if (chars(phase.title) > MAX_PHASE_TITLE_CHARS) {
      return `A section heading is too long (the limit is ${MAX_PHASE_TITLE_CHARS} characters).`;
    }
    if (phase.intro.length > MAX_PHASE_INTRO_LINES) {
      return `A section can have at most ${MAX_PHASE_INTRO_LINES} lines before its first step.`;
    }
    for (const step of phase.steps) {
      if (chars(step.body.trim()) > MAX_STEP_BODY_CHARS) {
        return `Step ${step.n} is too long (the limit is ${n(MAX_STEP_BODY_CHARS)} characters).`;
      }
      if (step.notes.length > MAX_STEP_NOTES) {
        return `Step ${step.n} has too many notes (the limit is ${MAX_STEP_NOTES}).`;
      }
    }
  }
  if (recipe.servings !== null && chars(recipe.servings) > MAX_SERVINGS_CHARS) {
    return `Servings is too long (the limit is ${MAX_SERVINGS_CHARS} characters).`;
  }
  return null;
}

/** The final RPC payload, measured as save_recipe measures it. */
export function payloadLimitError(payload: unknown): string | null {
  return jsonbTextBytes(payload) > MAX_PAYLOAD_BYTES
    ? "This recipe is too large to save. Try shortening the method or ingredients."
    : null;
}
