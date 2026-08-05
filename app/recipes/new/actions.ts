"use server";

/**
 * Server Actions for the add-a-recipe flow (issue #12c) — the thin Next.js
 * boundary. Build the RLS-scoped cookie-session client (runs as the signed-in
 * user; no service-role key), resolve the caller's identity from the VERIFIED
 * session, delegate to the pure `ingest-core` orchestration (supplying the
 * REAL SSRF-guarded fetcher), then revalidate `/recipes`.
 *
 * `recipe_ingested` (ADR 0004) is emitted only on a URL-SOURCED save — a
 * by-hand add (no `sourceUrl`) is not "ingested". Analytics failures never
 * block or surface to the user (`emitEvent` fails closed internally).
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { emitEvent } from "@/lib/analytics/events";
import { safeFetchHtml } from "@/lib/http/safe-fetch";
import { createServerComponentClient } from "@/lib/supabase/server-component";

import { GENERIC_ERROR, resolveRecipeActor } from "./actor";
import {
  EMPTY_RECIPE_PREVIEW,
  fetchRecipePreview,
  saveIngestedDish,
  type RecipePreviewFields,
} from "./ingest-core";

export type PreviewState =
  | null
  | { ok: true; sourceUrl: string; preview: RecipePreviewFields }
  | { ok: false; notice: string; preview: RecipePreviewFields };

export async function fetchRecipePreviewAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveRecipeActor(supabase);
  if (!actor) {
    return { ok: false, notice: GENERIC_ERROR, preview: EMPTY_RECIPE_PREVIEW };
  }

  return fetchRecipePreview(safeFetchHtml, String(formData.get("url") ?? ""));
}

// Success navigates away (PRG, kickoff resolution 2), so there is no on-page
// "saved" state — only the failure arm is a returned state.
export type SaveState = null | { error: string };

export async function saveIngestedDishAction(
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveRecipeActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();

  const result = await saveIngestedDish(supabase, {
    householdId: actor.householdId,
    createdBy: actor.memberId,
    title: String(formData.get("title") ?? ""),
    sourceUrl,
    imageUrl: String(formData.get("imageUrl") ?? ""),
    prepMinutes: String(formData.get("prepMinutes") ?? ""),
    cookMinutes: String(formData.get("cookMinutes") ?? ""),
    totalMinutes: String(formData.get("totalMinutes") ?? ""),
    ingredientsText: String(formData.get("ingredients") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  // Gate `recipe_ingested` on the SCRUBBED source URL the save actually
  // persisted — not the raw form value. A directly-invoked action carrying an
  // unsafe `sourceUrl` (e.g. `javascript:…`) stores `source_url = null`, so it
  // was not a real URL-sourced ingest and must not emit the event.
  if (result.sourceUrl) {
    await emitEvent(supabase, {
      householdId: actor.householdId,
      memberId: actor.memberId,
      eventType: "recipe_ingested",
      payload: { dishId: result.dishId },
    });
  }

  // Post/Redirect/Get to the saved recipe's canonical URL (kickoff resolution
  // 2). Leaving the user on /recipes/new with a populated form lets a back
  // button + re-submit create a DUPLICATE dish; redirecting to a resource URL
  // removes that entire edge-case class. `revalidatePath` still refreshes the
  // library behind the redirect. `redirect()` throws NEXT_REDIRECT, so nothing
  // after it runs and the success path never returns a value (its type is
  // `never`) — do NOT wrap it in a try/catch that swallows that control-flow
  // signal. A benign ingredients-partial save is not surfaced inline anymore;
  // the detail page simply shows the dish with no ingredient lines.
  revalidatePath("/recipes");
  redirect(`/recipes/${result.dishId}`);
}
