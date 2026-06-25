/**
 * Framework-free core for reactions: the idempotent toggle decision and the
 * per-proposal tally. Kept pure so they're exhaustively unit-tested and reused by
 * the thin server action (`social-core.ts`) and the reaction bar UI.
 */

import { REACTION_PALETTE, type ReactionKind } from "./palette";

/**
 * Decide what a tap on an emoji should do, given the member's CURRENT reaction row
 * for that (proposal, kind) — or null if they haven't reacted with it. The DB's
 * UNIQUE(proposal_id, member_id, kind) makes this idempotent: a present row toggles
 * OFF (delete it), an absent one toggles ON (insert). No duplicate rows possible.
 */
export function decideToggle(
  existing: { id: string } | null,
): { op: "insert" } | { op: "delete"; id: string } {
  return existing ? { op: "delete", id: existing.id } : { op: "insert" };
}

export type ReactionTally = {
  kind: ReactionKind;
  count: number;
  /** Did the current member react with this kind? (drives the "active" pill) */
  mine: boolean;
};

/**
 * Roll a proposal's reaction rows into one tally per palette kind, in palette
 * order, with the current member's own reactions flagged. Stray kinds outside the
 * palette (which the server guard prevents writing, but could predate it) are
 * ignored, so the bar only ever shows the fixed palette.
 */
export function tallyReactions(
  reactions: readonly { kind: string; member_id: string }[],
  currentMemberId: string,
): ReactionTally[] {
  return REACTION_PALETTE.map((kind) => {
    const forKind = reactions.filter((r) => r.kind === kind);
    return {
      kind,
      count: forKind.length,
      mine: forKind.some((r) => r.member_id === currentMemberId),
    };
  });
}
