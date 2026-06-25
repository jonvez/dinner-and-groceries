"use server";

/**
 * Server Actions for the week board (issue #8) — the thin Next.js boundary.
 * Build the RLS-scoped cookie-session client (runs as the signed-in user; no
 * service-role key), resolve the caller's household + member identity from the
 * VERIFIED session (never trusted from form input), delegate to the pure
 * `actions-core` writes, then revalidate the board.
 *
 * The submitted `weekStart` is treated as untrusted: it is validated as a real
 * date and re-normalized to the household's canonical week boundary so a crafted
 * value can't create an off-grid week. RLS still scopes every write to the
 * caller's household regardless.
 */

import { revalidatePath } from "next/cache";

import { createServerComponentClient } from "@/lib/supabase/server-component";

import { proposeExistingDish, proposeNewDish } from "./actions-core";
import { GENERIC_ERROR, resolveActor, resolveWeekId } from "./actor";

export type ProposeState = { error: string } | { added: true } | null;

export async function proposeNewDishAction(
  _prev: ProposeState,
  formData: FormData,
): Promise<ProposeState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const week = await resolveWeekId(
    supabase,
    actor,
    String(formData.get("weekStart") ?? ""),
  );
  if ("error" in week) return { error: week.error };

  const result = await proposeNewDish(supabase, {
    householdId: actor.householdId,
    weekId: week.weekId,
    proposedBy: actor.memberId,
    title: String(formData.get("title") ?? ""),
    sourceUrl: String(formData.get("sourceUrl") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/board");
  return { added: true };
}

export async function recycleDishAction(
  _prev: ProposeState,
  formData: FormData,
): Promise<ProposeState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const week = await resolveWeekId(
    supabase,
    actor,
    String(formData.get("weekStart") ?? ""),
  );
  if ("error" in week) return { error: week.error };

  const result = await proposeExistingDish(supabase, {
    householdId: actor.householdId,
    weekId: week.weekId,
    proposedBy: actor.memberId,
    dishId: String(formData.get("dishId") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/board");
  return { added: true };
}
