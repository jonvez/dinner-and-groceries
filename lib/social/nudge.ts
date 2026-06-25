/**
 * Framework-free core for the "nudge" behavior of the idea pool (issue #10). Two
 * distinct, deliberately-separate notions of "popular" (ADR 0003):
 *
 *   - NUDGE SORT ranks the pool by the TOTAL count of positive reactions (desc),
 *     tiebreaking on most-recent. This only re-orders the pool — it NEVER
 *     auto-places a dish onto the board. Reactions guide; a human still slots.
 *
 *   - The READY-TO-SLOT BADGE is earned by DISTINCT positive reactors crossing a
 *     threshold, so one member reacting with several positive kinds counts ONCE
 *     (you can't self-spam a badge). The threshold is a single tunable constant.
 *
 * Only the positive palette subset counts for either; neutral reactions (🤔) and
 * any off-palette kinds are ignored. Kept pure so both are exhaustively unit
 * tested and reused by the pool UI without a framework or DB.
 */

import { isPositiveReaction } from "./palette";

/**
 * Distinct positive reactors a proposal needs to earn the "ready to slot" badge
 * (ADR 0003). Tunable in this ONE place — bump it and the badge logic follows.
 */
export const READY_TO_SLOT_THRESHOLD = 2;

type ReactionLike = { kind: string; member_id: string };

export type NudgeProposal = {
  id: string;
  /** ISO timestamp; the most-recent tiebreaker for equal positive counts. */
  createdAt: string;
  reactions: readonly ReactionLike[];
};

/** Total number of positive reactions (the nudge-sort ranking signal). */
export function positiveReactionCount(
  reactions: readonly ReactionLike[],
): number {
  return reactions.filter((r) => isPositiveReaction(r.kind)).length;
}

/**
 * Number of DISTINCT members who gave at least one positive reaction — the badge
 * basis. A member reacting with multiple positive kinds is counted once.
 */
export function distinctPositiveReactorCount(
  reactions: readonly ReactionLike[],
): number {
  const reactors = new Set<string>();
  for (const r of reactions) {
    if (isPositiveReaction(r.kind)) reactors.add(r.member_id);
  }
  return reactors.size;
}

/** Has the proposal earned the ready-to-slot badge (>= threshold distinct positives)? */
export function isReadyToSlot(reactions: readonly ReactionLike[]): boolean {
  return distinctPositiveReactorCount(reactions) >= READY_TO_SLOT_THRESHOLD;
}

/**
 * Return a new, nudge-sorted array: positive-reaction count descending, ties
 * broken by most-recent `createdAt` first. Does not mutate the input. (Array
 * sort is stable, so equal-count + equal-timestamp rows keep their input order.)
 */
export function nudgeSort<T extends NudgeProposal>(
  proposals: readonly T[],
): T[] {
  return [...proposals].sort((a, b) => {
    const byCount =
      positiveReactionCount(b.reactions) - positiveReactionCount(a.reactions);
    if (byCount !== 0) return byCount;
    // Most-recent first: larger ISO string sorts earlier.
    return b.createdAt.localeCompare(a.createdAt);
  });
}
