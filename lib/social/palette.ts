/**
 * The reaction palette — the SINGLE editable source of truth for the emoji a
 * member may react with on a proposal (ADR 0003: "a small fixed positive/neutral
 * emoji palette … a single editable constant"). Add/remove an emoji HERE and the
 * server guard, the tally, and the reaction bar all follow.
 *
 * The set is deliberately positive/neutral — planning should feel like a
 * low-pressure group chat, never a place to dunk on someone's idea (SPEC north
 * star). Want a 🌶️ "spicy" reaction with the kids? It's a one-line change here.
 */
export const REACTION_PALETTE = ["👍", "❤️", "😋", "🔥", "🎉", "🤔"] as const;

export type ReactionKind = (typeof REACTION_PALETTE)[number];

/**
 * The POSITIVE subset of the palette — the emoji that count as enthusiasm for
 * the nudge sort and the ready-to-slot badge (ADR 0003: "sort by positive-reaction
 * count … badge at >=2 positive reactions from distinct members"). Deliberately a
 * STRICT subset: 🤔 ("thinking") is neutral and must NOT lift or badge a proposal.
 * Add an emoji to the palette above and it stays non-positive until listed here —
 * so a new reaction can never silently start nudging the plan.
 */
export const POSITIVE_REACTIONS = ["👍", "❤️", "😋", "🔥", "🎉"] as const;

export type PositiveReactionKind = (typeof POSITIVE_REACTIONS)[number];

/** Is `kind` a positive reaction (counts toward nudge sort + the badge)? */
export function isPositiveReaction(kind: string): kind is PositiveReactionKind {
  return (POSITIVE_REACTIONS as readonly string[]).includes(kind);
}

/**
 * Server-side guard: is `kind` one of the palette emoji? The reaction `kind`
 * arrives from the client, so it is untrusted — this constrains it to the palette
 * before any write (no fuzzy/whitespace matching: an exact membership check).
 */
export function isReactionKind(kind: string): kind is ReactionKind {
  return (REACTION_PALETTE as readonly string[]).includes(kind);
}
