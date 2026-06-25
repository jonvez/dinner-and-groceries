// STUB (red): real implementation lands in the green commit.

export const READY_TO_SLOT_THRESHOLD = 2;

type ReactionLike = { kind: string; member_id: string };

export type NudgeProposal = {
  id: string;
  createdAt: string;
  reactions: readonly ReactionLike[];
};

export function positiveReactionCount(
  _reactions: readonly ReactionLike[],
): number {
  return 0;
}

export function distinctPositiveReactorCount(
  _reactions: readonly ReactionLike[],
): number {
  return 0;
}

export function isReadyToSlot(_reactions: readonly ReactionLike[]): boolean {
  return false;
}

export function nudgeSort<T extends NudgeProposal>(
  proposals: readonly T[],
): T[] {
  return [...proposals];
}
