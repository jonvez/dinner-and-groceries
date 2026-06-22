import { describe, expect, it } from "vitest";

import { userScopedClientOptions } from "./client-options";

describe("userScopedClientOptions", () => {
  it("attaches the user's access token as a Bearer Authorization header", () => {
    const opts = userScopedClientOptions("user-jwt-123");

    expect(opts.global.headers.Authorization).toBe("Bearer user-jwt-123");
  });

  it("disables session persistence/refresh (request-scoped server client)", () => {
    const opts = userScopedClientOptions("user-jwt-123");

    expect(opts.auth.persistSession).toBe(false);
    expect(opts.auth.autoRefreshToken).toBe(false);
    expect(opts.auth.detectSessionInUrl).toBe(false);
  });

  it("throws when the access token is empty (no anonymous/elevated fallback)", () => {
    expect(() => userScopedClientOptions("")).toThrow(/access token is required/i);
    expect(() => userScopedClientOptions("   ")).toThrow(/access token is required/i);
  });

  it("throws when the access token is not a string", () => {
    // @ts-expect-error — exercising the runtime guard against bad callers.
    expect(() => userScopedClientOptions(undefined)).toThrow(/access token is required/i);
  });
});
