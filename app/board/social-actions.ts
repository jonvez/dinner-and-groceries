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
 *
 * Analytics (issue #210): `reaction_added` is emitted ONLY when the toggle turns
 * a reaction ON — an un-react emits nothing, because there is no
 * `reaction_removed` in the taxonomy and adding one would be a migration plus an
 * ADR amendment (ADR 0014). `comment_added` records that a comment happened and
 * on which proposal; the comment BODY never leaves the `comments` table.
 */

import { revalidatePath } from "next/cache";

import { emitEvent } from "@/lib/analytics/events";
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

  const proposalId = String(formData.get("proposalId") ?? "");

  const result = await toggleReaction(supabase, {
    householdId: actor.householdId,
    proposalId,
    memberId: actor.memberId,
    kind,
  });
  if (!result.ok) return { error: result.error };

  // Toggle-ON only. `kind` is a palette emoji (a fixed enum, not free text).
  if (result.toggled === "on") {
    await emitEvent(supabase, {
      householdId: actor.householdId,
      memberId: actor.memberId,
      eventType: "reaction_added",
      payload: { proposalId, kind },
    });
  }

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

  const proposalId = String(formData.get("proposalId") ?? "");

  const result = await addComment(supabase, {
    householdId: actor.householdId,
    proposalId,
    memberId: actor.memberId,
    body: String(formData.get("body") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  // Ids only — the comment text stays in `comments`, never in an event payload.
  await emitEvent(supabase, {
    householdId: actor.householdId,
    memberId: actor.memberId,
    eventType: "comment_added",
    payload: { proposalId },
  });

  revalidatePath("/board");
  return { added: true };
}
