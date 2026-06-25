/**
 * Pure orchestration for the board's social writes (issue #9) — the react/unreact
 * toggle and add-comment, taking an injected Supabase-like client so they're
 * unit-tested WITHOUT a live DB (mirrors `actions-core.ts`). The thin Server
 * Actions (`social-actions.ts`) build the real RLS-scoped cookie-session client
 * (no service-role key), resolve the caller's household + member identity from the
 * VERIFIED session, then call these.
 *
 * Security contract:
 *   - `kind` is constrained to the fixed palette HERE (defense in depth — the
 *     action validates too) so an untrusted client emoji can never be persisted.
 *   - `householdId` / `memberId` come from the caller (verified session), never
 *     from form input. RLS + the composite (proposal_id, household_id) FK scope
 *     every write to the caller's household and a proposal within it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { normalizeCommentBody } from "@/lib/social/comments";
import { isReactionKind } from "@/lib/social/palette";
import { decideToggle } from "@/lib/social/reactions";

type DbClient = SupabaseClient<Database>;

export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const GENERIC = "Something went wrong. Please try again.";

/**
 * Toggle the caller's reaction of `kind` on a proposal. Idempotent on the unique
 * (proposal_id, member_id, kind): if a row already exists it's removed (toggle
 * off), otherwise one is inserted (toggle on) — never a duplicate row.
 */
export async function toggleReaction(
  supabase: Pick<DbClient, "from">,
  input: {
    householdId: string;
    proposalId: string;
    memberId: string;
    kind: string;
  },
): Promise<ActionResult<{ toggled: "on" | "off" }>> {
  // Constrain the untrusted client `kind` to the palette before touching the DB.
  if (!isReactionKind(input.kind)) {
    return { ok: false, error: "That reaction isn't available." };
  }
  if (input.proposalId.trim() === "") {
    return { ok: false, error: GENERIC };
  }

  // Look up THIS member's existing reaction for this (proposal, kind).
  const { data: existing, error: lookupError } = await supabase
    .from("reactions")
    .select("id")
    .eq("proposal_id", input.proposalId)
    .eq("member_id", input.memberId)
    .eq("kind", input.kind)
    .maybeSingle();

  if (lookupError) return { ok: false, error: GENERIC };

  const decision = decideToggle(existing ?? null);

  if (decision.op === "delete") {
    const { error } = await supabase
      .from("reactions")
      .delete()
      .eq("id", decision.id);
    if (error) return { ok: false, error: GENERIC };
    return { ok: true, toggled: "off" };
  }

  const { data, error } = await supabase
    .from("reactions")
    .insert({
      household_id: input.householdId,
      proposal_id: input.proposalId,
      member_id: input.memberId,
      kind: input.kind,
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: GENERIC };
  return { ok: true, toggled: "on" };
}

/** Add a comment to a proposal. Body is normalized + length-capped first. */
export async function addComment(
  supabase: Pick<DbClient, "from">,
  input: {
    householdId: string;
    proposalId: string;
    memberId: string;
    body: string;
  },
): Promise<ActionResult<{ commentId: string }>> {
  const normalized = normalizeCommentBody(input.body);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  if (input.proposalId.trim() === "") {
    return { ok: false, error: GENERIC };
  }

  const { data, error } = await supabase
    .from("comments")
    .insert({
      household_id: input.householdId,
      proposal_id: input.proposalId,
      member_id: input.memberId,
      body: normalized.body,
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: GENERIC };
  return { ok: true, commentId: data.id };
}
