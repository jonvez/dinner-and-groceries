import { describe, expect, it } from "vitest";

import { INVITE_PATH, inviteUrl, parseInviteToken } from "./url";

describe("inviteUrl", () => {
  it("builds an absolute join URL carrying the token", () => {
    expect(inviteUrl("abc123", "https://app.example.com")).toBe(
      "https://app.example.com/join/abc123",
    );
  });

  it("trims a trailing slash on the origin", () => {
    expect(inviteUrl("tok", "https://app.example.com/")).toBe(
      "https://app.example.com/join/tok",
    );
  });

  it("URL-encodes the token path segment", () => {
    // base64url tokens never contain reserved chars, but encode defensively.
    expect(inviteUrl("a/b", "https://x.test")).toBe(
      "https://x.test/join/a%2Fb",
    );
  });
});

describe("parseInviteToken", () => {
  it("returns the token from a /join/<token> path", () => {
    expect(parseInviteToken("abc123")).toBe("abc123");
  });

  it("trims surrounding whitespace", () => {
    expect(parseInviteToken("  tok  ")).toBe("tok");
  });

  it("returns null for an empty/whitespace token", () => {
    expect(parseInviteToken("")).toBeNull();
    expect(parseInviteToken("   ")).toBeNull();
    expect(parseInviteToken(undefined)).toBeNull();
  });

  it("rejects an over-long token (defensive cap)", () => {
    expect(parseInviteToken("x".repeat(1025))).toBeNull();
  });

  it("rejects tokens with characters outside the base64url alphabet", () => {
    expect(parseInviteToken("not a token!")).toBeNull();
    expect(parseInviteToken("../etc/passwd")).toBeNull();
  });

  it("exposes the canonical join path prefix", () => {
    expect(INVITE_PATH).toBe("/join");
  });
});
