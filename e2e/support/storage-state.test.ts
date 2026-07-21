import { describe, expect, it } from "vitest";

import { sessionCookiesToStorageState } from "./storage-state";

/**
 * The seeded `@supabase/ssr` session is captured as raw name/value cookies from
 * an in-memory jar; this converts them into the Playwright `storageState` shape.
 * The security-relevant flags (httpOnly, secure, sameSite) must match the app's
 * real auth-cookie policy (lib/supabase/cookie-options.ts) so the seeded session
 * behaves exactly like a real one — hence a focused unit test.
 */
describe("sessionCookiesToStorageState", () => {
  const captured = [
    { name: "sb-127-auth-token", value: "base64-abc" },
    { name: "sb-127-auth-token.1", value: "base64-def" },
  ];

  it("maps each captured cookie onto the seed domain/path with the app's auth-cookie flags", () => {
    const state = sessionCookiesToStorageState(captured, {
      domain: "127.0.0.1",
      secure: false,
      expiresUnixSec: 9999999999,
    });

    expect(state.origins).toEqual([]);
    expect(state.cookies).toHaveLength(2);

    for (const cookie of state.cookies) {
      expect(cookie.domain).toBe("127.0.0.1");
      expect(cookie.path).toBe("/");
      expect(cookie.expires).toBe(9999999999);
      // Matches the app's real session-cookie policy so the seeded session is
      // indistinguishable from a Google-minted one (httpOnly + sameSite=Lax).
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Lax");
      expect(cookie.secure).toBe(false);
    }

    expect(state.cookies.map((c) => [c.name, c.value])).toEqual([
      ["sb-127-auth-token", "base64-abc"],
      ["sb-127-auth-token.1", "base64-def"],
    ]);
  });

  it("honors the secure flag for HTTPS deployments", () => {
    const state = sessionCookiesToStorageState(captured, {
      domain: "example.com",
      secure: true,
      expiresUnixSec: 1,
    });
    expect(state.cookies.every((c) => c.secure)).toBe(true);
    expect(state.cookies.every((c) => c.domain === "example.com")).toBe(true);
  });
});
