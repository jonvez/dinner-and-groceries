import { describe, expect, it } from "vitest";

import { decideToggle, tallyReactions } from "./reactions";
import { REACTION_PALETTE } from "./palette";

/**
 * The idempotent reaction toggle and the per-proposal tally — the framework-free
 * core behind react/unreact. `decideToggle` encodes the toggle RULE (tap an emoji
 * you haven't used → insert; tap one you have → remove), keyed by the unique
 * (proposal_id, member_id, kind). `tallyReactions` rolls a proposal's reaction
 * rows into palette-ordered counts plus whether the current member reacted.
 */

const [THUMBS, HEART] = REACTION_PALETTE;

describe("decideToggle", () => {
  it("inserts when the member has not yet reacted with this kind", () => {
    expect(decideToggle(null)).toEqual({ op: "insert" });
  });

  it("deletes the existing row when the member already reacted with this kind", () => {
    expect(decideToggle({ id: "r1" })).toEqual({ op: "delete", id: "r1" });
  });
});

describe("tallyReactions", () => {
  it("counts reactions per kind and flags the current member's own", () => {
    const tally = tallyReactions(
      [
        { kind: THUMBS, member_id: "me" },
        { kind: THUMBS, member_id: "alex" },
        { kind: HEART, member_id: "alex" },
      ],
      "me",
    );
    const thumbs = tally.find((t) => t.kind === THUMBS);
    const heart = tally.find((t) => t.kind === HEART);
    expect(thumbs).toMatchObject({ count: 2, mine: true });
    expect(heart).toMatchObject({ count: 1, mine: false });
  });

  it("returns one entry per palette kind, in palette order", () => {
    const tally = tallyReactions([], "me");
    expect(tally.map((t) => t.kind)).toEqual([...REACTION_PALETTE]);
    expect(tally.every((t) => t.count === 0 && t.mine === false)).toBe(true);
  });

  it("ignores stray kinds that are not in the palette (defense in depth)", () => {
    const tally = tallyReactions(
      [
        { kind: "💩", member_id: "me" },
        { kind: THUMBS, member_id: "me" },
      ],
      "me",
    );
    expect(tally.find((t) => t.kind === THUMBS)?.count).toBe(1);
    expect(tally.some((t) => t.kind === "💩")).toBe(false);
  });
});
