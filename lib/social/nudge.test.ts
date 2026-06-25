import { describe, expect, it } from "vitest";

import { REACTION_PALETTE } from "./palette";
import {
  READY_TO_SLOT_THRESHOLD,
  distinctPositiveReactorCount,
  isReadyToSlot,
  nudgeSort,
  positiveReactionCount,
  type NudgeProposal,
} from "./nudge";

/**
 * The two pieces of "nudge" logic are the riskiest in issue #10 (ADR 0003),
 * so they are pure, framework-free, and exhaustively unit-tested here:
 *
 *   (a) NUDGE SORT — order the pool by positive-reaction count (desc), tiebreak
 *       most-recent. Reactions only GUIDE ordering; they never auto-place.
 *   (b) READY-TO-SLOT BADGE — earned at >= READY_TO_SLOT_THRESHOLD positive
 *       reactions from DISTINCT members. A single member reacting with several
 *       positive kinds must count ONCE toward the badge (no self-spamming over
 *       the threshold). Neutral palette kinds never count.
 */

// A positive and a neutral kind drawn from the live palette so the test tracks
// the real palette rather than hard-coded emoji.
const POS = REACTION_PALETTE[0]; // 👍 (positive)
const POS2 = REACTION_PALETTE[1]; // ❤️ (positive)
const NEUTRAL = REACTION_PALETTE[REACTION_PALETTE.length - 1]; // 🤔 (neutral)

function rx(member_id: string, kind: string) {
  return { member_id, kind };
}

describe("positiveReactionCount", () => {
  it("counts every positive reaction (total, not distinct)", () => {
    expect(
      positiveReactionCount([rx("a", POS), rx("b", POS), rx("a", POS2)]),
    ).toBe(3);
  });

  it("ignores neutral palette kinds", () => {
    expect(positiveReactionCount([rx("a", NEUTRAL), rx("b", NEUTRAL)])).toBe(0);
  });

  it("ignores off-palette / unknown kinds", () => {
    expect(positiveReactionCount([rx("a", "💩"), rx("b", "")])).toBe(0);
  });

  it("is 0 for no reactions", () => {
    expect(positiveReactionCount([])).toBe(0);
  });
});

describe("distinctPositiveReactorCount (badge basis)", () => {
  it("counts each distinct member once even with several positive kinds", () => {
    // Single member spamming three positive kinds -> ONE distinct reactor.
    expect(
      distinctPositiveReactorCount([
        rx("solo", POS),
        rx("solo", POS2),
        rx("solo", REACTION_PALETTE[2]),
      ]),
    ).toBe(1);
  });

  it("counts two different members as two", () => {
    expect(
      distinctPositiveReactorCount([rx("a", POS), rx("b", POS2)]),
    ).toBe(2);
  });

  it("excludes members whose only reactions are neutral", () => {
    expect(
      distinctPositiveReactorCount([rx("a", POS), rx("b", NEUTRAL)]),
    ).toBe(1);
  });

  it("is 0 for no reactions", () => {
    expect(distinctPositiveReactorCount([])).toBe(0);
  });
});

describe("isReadyToSlot (badge threshold)", () => {
  it("threshold is a single tunable constant of 2", () => {
    expect(READY_TO_SLOT_THRESHOLD).toBe(2);
  });

  it("is NOT ready when one member spams several positive reactions (distinct rule)", () => {
    // The headline security/correctness edge: self-spamming must not cross it.
    expect(
      isReadyToSlot([rx("solo", POS), rx("solo", POS2), rx("solo", REACTION_PALETTE[2])]),
    ).toBe(false);
  });

  it("is ready at two distinct positive reactors", () => {
    expect(isReadyToSlot([rx("a", POS), rx("b", POS)])).toBe(true);
  });

  it("is NOT ready when the second reactor only gave a neutral reaction", () => {
    expect(isReadyToSlot([rx("a", POS), rx("b", NEUTRAL)])).toBe(false);
  });

  it("is NOT ready with no reactions", () => {
    expect(isReadyToSlot([])).toBe(false);
  });
});

describe("nudgeSort", () => {
  const base: NudgeProposal[] = [
    { id: "old-popular", createdAt: "2026-06-20T10:00:00Z", reactions: [] },
    { id: "new-quiet", createdAt: "2026-06-22T10:00:00Z", reactions: [] },
    { id: "mid", createdAt: "2026-06-21T10:00:00Z", reactions: [] },
  ];

  it("orders by positive-reaction count descending", () => {
    const proposals: NudgeProposal[] = [
      { ...base[0], reactions: [rx("a", POS)] }, // 1 positive
      { ...base[1], reactions: [rx("a", POS), rx("b", POS), rx("c", POS2)] }, // 3
      { ...base[2], reactions: [rx("a", POS), rx("b", POS)] }, // 2
    ];
    expect(nudgeSort(proposals).map((p) => p.id)).toEqual([
      "new-quiet",
      "mid",
      "old-popular",
    ]);
  });

  it("breaks ties on count by most-recent createdAt first", () => {
    // All three have the same positive count (0) -> newest first.
    expect(nudgeSort(base).map((p) => p.id)).toEqual([
      "new-quiet",
      "mid",
      "old-popular",
    ]);
  });

  it("counts only positive reactions for ranking (neutral does not lift a proposal)", () => {
    const proposals: NudgeProposal[] = [
      { id: "neutral-heavy", createdAt: "2026-06-20T10:00:00Z", reactions: [rx("a", NEUTRAL), rx("b", NEUTRAL)] },
      { id: "one-positive", createdAt: "2026-06-19T10:00:00Z", reactions: [rx("a", POS)] },
    ];
    expect(nudgeSort(proposals).map((p) => p.id)).toEqual([
      "one-positive",
      "neutral-heavy",
    ]);
  });

  it("returns a new array and does not mutate the input", () => {
    const input = [...base];
    const out = nudgeSort(input);
    expect(out).not.toBe(input);
    expect(input.map((p) => p.id)).toEqual(["old-popular", "new-quiet", "mid"]);
  });

  it("handles an empty pool", () => {
    expect(nudgeSort([])).toEqual([]);
  });
});
