import { describe, expect, it } from "vitest";

import { MAX_COMMENT_LENGTH, normalizeCommentBody } from "./comments";

/**
 * Comment body normalization — the server-side guard before persisting a comment.
 * Trims, rejects empty/whitespace-only (the DB CHECK also enforces non-empty),
 * and caps length so a member can't store an unbounded body. Rendering escaping is
 * handled by React's default text rendering (no dangerouslySetInnerHTML).
 */

describe("normalizeCommentBody", () => {
  it("trims surrounding whitespace and accepts real text", () => {
    expect(normalizeCommentBody("  yum let's do this  ")).toEqual({
      ok: true,
      body: "yum let's do this",
    });
  });

  it("rejects an empty or whitespace-only body", () => {
    expect(normalizeCommentBody("").ok).toBe(false);
    expect(normalizeCommentBody("   \n\t ").ok).toBe(false);
  });

  it("accepts a body exactly at the length cap", () => {
    const body = "a".repeat(MAX_COMMENT_LENGTH);
    expect(normalizeCommentBody(body)).toEqual({ ok: true, body });
  });

  it("rejects a body over the length cap", () => {
    const result = normalizeCommentBody("a".repeat(MAX_COMMENT_LENGTH + 1));
    expect(result.ok).toBe(false);
  });
});
