import { describe, expect, it } from "vitest";

import { INVITE_TOKEN_BYTES, mintInviteToken } from "./token";

describe("mintInviteToken", () => {
  it("produces a URL-safe token (base64url alphabet only)", () => {
    for (let i = 0; i < 100; i++) {
      const token = mintInviteToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("carries sufficient entropy (>= 128 bits of random bytes)", () => {
    // base64url has no padding; the decoded length is the random byte count.
    // 128 bits = 16 bytes is the floor; we mint more.
    expect(INVITE_TOKEN_BYTES).toBeGreaterThanOrEqual(16);
    const decodedBytes = Buffer.from(mintInviteToken(), "base64url").length;
    expect(decodedBytes).toBe(INVITE_TOKEN_BYTES);
  });

  it("is effectively unique across many mints (CSPRNG, no collisions)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const token = mintInviteToken();
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
    expect(seen.size).toBe(10_000);
  });

  it("has length > 0 (satisfies the invites.token CHECK constraint)", () => {
    expect(mintInviteToken().length).toBeGreaterThan(0);
  });
});
