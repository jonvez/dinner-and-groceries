/**
 * The one domain write path for a whole recipe (issue #272). Every writer (the
 * add form today; the MCP companion and the edit UI #89 next) calls
 * `saveRecipe`; nothing reimplements the parsing or the inserts.
 *
 * It turns author-friendly text (ingredients one per line with "## Section"
 * headers; the method as markdown, see `method-parse.ts`) into the
 * `public.save_recipe(jsonb)` payload, and makes ONE RPC call. That function is
 * SECURITY INVOKER and runs in one transaction, so RLS scopes everything to the
 * caller's household and a save either fully lands or doesn't happen. Household
 * and author are derived in SQL from the session, never sent from here.
 *
 * Stable step ids: on an update, the dish's current steps are read first and
 * each incoming step takes the id of an existing step with an IDENTICAL trimmed
 * body (first unused match, in order). Cook progress is keyed by step id, so a
 * revision made mid-cook keeps every unchanged step's progress.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { safeHttpUrl } from "@/lib/web/safe-url";

import { parseIngredient } from "./ingredient";
import { parseMethod, type Phase } from "./method-parse";

type DbClient = SupabaseClient<Database>;

export type RecipeInput = {
  /** null/absent = create; present = replace that dish's content. */
  id?: string | null;
  title: string;
  sourceUrl?: string | null;
  imageUrl?: string | null;
  prepMinutes?: number | null;
  cookMinutes?: number | null;
  totalMinutes?: number | null;
  servings?: string | null;
  /** Omitted = leave tags unchanged on update ('{}' on create). */
  tags?: string[];
  /** One ingredient per line; a "## Section" line opens a group. */
  ingredientsText: string;
  /** Method markdown (## phase / N. step / - note / [[chip]] / **bold**). */
  methodText: string;
};

export type SaveRecipeResult = { ok: true; dishId: string } | { ok: false; error: string };

export type IngredientPayload = {
  name: string;
  quantity: number | null;
  unit: string | null;
  raw_text: string;
  section: string | null;
};

export type StepPayload = { id: string | null; body: string; notes: string[] };
export type PhasePayload = { title: string; intro: string[]; steps: StepPayload[] };

const SAVE_FAILED = "We couldn't save that recipe. Please try again.";

/**
 * Non-blank lines in order, each tagged with the section opened by the most
 * recent "## Header" line (null before any header). Header lines themselves
 * are not ingredients.
 */
export function parseIngredientSections(text: string): { line: string; section: string | null }[] {
  const out: { line: string; section: string | null }[] = [];
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      section = line.slice(3).trim() || null;
      continue;
    }
    out.push({ line, section });
  }
  return out;
}

/**
 * One ingredient row per line. `name` is the parser's display name, falling
 * back to the verbatim line when parsing yields nothing (e.g. a bare quantity
 * like "2"): the `name` column is NOT NULL + non-empty, so a fallback is
 * required, never optional.
 */
export function ingredientsFromText(text: string): IngredientPayload[] {
  return parseIngredientSections(text).map(({ line, section }) => {
    const parsed = parseIngredient(line);
    const name = parsed.name.trim() === "" ? parsed.rawText.trim() : parsed.name;
    return {
      name,
      quantity: parsed.quantity,
      unit: parsed.unit,
      raw_text: parsed.rawText,
      section,
    };
  });
}

/**
 * Give each parsed step the id of an existing step with the identical trimmed
 * body (first unused match, in order), else null (the RPC mints a new id).
 * Duplicate bodies therefore map one-to-one in order.
 */
export function assignStepIds(
  phases: Phase[],
  existing: readonly { id: string; body: string }[],
): PhasePayload[] {
  const pool = existing.map((step) => ({ id: step.id, body: step.body.trim(), used: false }));
  return phases.map((phase) => ({
    title: phase.title,
    intro: phase.intro,
    steps: phase.steps.map((step) => {
      const body = step.body.trim();
      const match = pool.find((candidate) => !candidate.used && candidate.body === body);
      if (match) match.used = true;
      return { id: match?.id ?? null, body, notes: step.notes };
    }),
  }));
}

function minutes(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export async function saveRecipe(
  supabase: Pick<DbClient, "from" | "rpc">,
  input: RecipeInput,
): Promise<SaveRecipeResult> {
  const title = input.title.trim();
  if (title === "") return { ok: false, error: "Give the recipe a title." };

  const id = input.id ?? null;
  let existing: { id: string; body: string }[] = [];
  if (id !== null) {
    const { data, error } = await supabase
      .from("dish_steps")
      .select("id, body")
      .eq("dish_id", id)
      .order("position", { ascending: true });
    // Saving without the current steps would silently re-mint every step id
    // (and reset cook progress), so fail closed instead.
    if (error || !data) return { ok: false, error: SAVE_FAILED };
    existing = data;
  }

  const recipe = {
    id,
    title,
    // Scheme-validate every URL that could reach storage. An unsafe image or
    // source URL is DROPPED (stored as null), never a reason to block a save.
    source_url: safeHttpUrl(input.sourceUrl ?? null),
    image_url: safeHttpUrl(input.imageUrl ?? null),
    prep_minutes: minutes(input.prepMinutes),
    cook_minutes: minutes(input.cookMinutes),
    total_minutes: minutes(input.totalMinutes),
    servings: blankToNull(input.servings),
    ...(input.tags !== undefined
      ? { tags: input.tags.map((tag) => tag.trim()).filter((tag) => tag !== "") }
      : {}),
    ingredients: ingredientsFromText(input.ingredientsText),
    phases: assignStepIds(parseMethod(input.methodText), existing),
  };

  const { data: dishId, error } = await supabase.rpc("save_recipe", { p_recipe: recipe });
  if (error || !dishId) {
    if (error?.code === "P0002") return { ok: false, error: "That recipe no longer exists." };
    return { ok: false, error: SAVE_FAILED };
  }
  return { ok: true, dishId };
}
