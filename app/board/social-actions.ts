"use server";

/**
 * Server Actions for the social layer (issue #9) — the thin Next.js boundary for
 * react/unreact and commenting. Build the RLS-scoped cookie-session client (runs
 * as the signed-in user; no service-role key), resolve the caller's household +
 * member identity from the VERIFIED session (never from form input), delegate to
 * the pure `social-core` writes, then revalidate the board.
 *
 * The board's correctness does NOT depend on Realtime: this revalidate is what
 * refreshes the acting member's own view (Realtime then pushes the change to the
 * OTHER members live). `proposalId` is untrusted, but RLS + the composite
 * (proposal_id, household_id) FK guarantee a member can only react/comment on a
 * proposal within their own household. The reaction `kind` is constrained to the
 * fixed palette server-side here AND in core (defense in depth).
 */

import { revalidatePath } from "next/cache";

import { createServerComponentClient } from "@/lib/supabase/server-component";
import { isReactionKind } from "@/lib/social/palette";

import { GENERIC_ERROR, resolveActor } from "./actor";
import { addComment, toggleReaction } from "./social-core";

export type ReactState =
  | { error: string }
  | { toggled: "on" | "off" }
  | null;

export type CommentState = { error: string } | { added: true } | null;

export async function reactAction(
  _prev: ReactState,
  formData: FormData,
): Promise<ReactState> {
  const kind = String(formData.get("kind") ?? "");
  // Reject an off-palette kind up front (core re-checks). Never trust the client.
  if (!isReactionKind(kind)) return { error: "That reaction isn't available." };

  const supabase = await createServerComponentClient();
  const actor = await resolveActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const result = await toggleReaction(supabase, {
    householdId: actor.householdId,
    proposalId: String(formData.get("proposalId") ?? ""),
    memberId: actor.memberId,
    kind,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/board");
  return { toggled: result.toggled };
}

export async function addCommentAction(
  _prev: CommentState,
  formData: FormData,
): Promise<CommentState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const result = await addComment(supabase, {
    householdId: actor.householdId,
    proposalId: String(formData.get("proposalId") ?? ""),
    memberId: actor.memberId,
    body: String(formData.get("body") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/board");
  return { added: true };
}
