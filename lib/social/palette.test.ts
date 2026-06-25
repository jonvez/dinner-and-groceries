import { describe, expect, it } from "vitest";

import { REACTION_PALETTE, isReactionKind } from "./palette";

/**
 * The reaction palette is the SINGLE editable source of truth for which emoji a
 * member may react with (ADR 0003 — "a single editable constant"). `isReactionKind`
 * is the server-side guard that constrains an untrusted, client-sent `kind` to that
 * palette (security: never trust the client's emoji).
 */

describe("REACTION_PALETTE", () => {
  it("is a non-empty list of distinct, trimmed emoji strings", () => {
    expect(REACTION_PALETTE.length).toBeGreaterThan(0);
    for (const kind of REACTION_PALETTE) {
      expect(typeof kind).toBe("string");
      expect(kind.length).toBeGreaterThan(0);
      expect(kind).toBe(kind.trim());
    }
    expect(new Set(REACTION_PALETTE).size).toBe(REACTION_PALETTE.length);
  });
});

describe("isReactionKind", () => {
  it("accepts every emoji in the palette", () => {
    for (const kind of REACTION_PALETTE) {
      expect(isReactionKind(kind)).toBe(true);
    }
  });

  it("rejects anything outside the palette (untrusted client kind)", () => {
    expect(isReactionKind("💩")).toBe(false);
    expect(isReactionKind("")).toBe(false);
    expect(isReactionKind("<script>alert(1)</script>")).toBe(false);
    expect(isReactionKind("not-an-emoji")).toBe(false);
  });

  it("rejects a palette emoji padded with whitespace (no fuzzy match)", () => {
    expect(isReactionKind(`${REACTION_PALETTE[0]} `)).toBe(false);
  });
});
