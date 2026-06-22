import { describe, expect, it } from "vitest";

import { authCookieOptions } from "./cookie-options";

describe("authCookieOptions", () => {
  it("is httpOnly so the access/refresh tokens are never readable from JS", () => {
    expect(authCookieOptions({ isProduction: true }).httpOnly).toBe(true);
  });

  it("is path-scoped to the whole app", () => {
    expect(authCookieOptions({ isProduction: true }).path).toBe("/");
  });

  it("uses sameSite=lax so the OAuth top-level redirect carries the cookie", () => {
    // `lax` lets the cookie ride the top-level GET redirect back from Google,
    // while still blocking it on cross-site sub-requests (CSRF defense).
    expect(authCookieOptions({ isProduction: true }).sameSite).toBe("lax");
  });

  it("sets Secure in production (HTTPS-only)", () => {
    expect(authCookieOptions({ isProduction: true }).secure).toBe(true);
  });

  it("omits Secure in local dev so http://127.0.0.1 works", () => {
    expect(authCookieOptions({ isProduction: false }).secure).toBe(false);
  });

  it("defaults isProduction from NODE_ENV when not given", () => {
    const prod = authCookieOptions(undefined, { NODE_ENV: "production" });
    expect(prod.secure).toBe(true);
    const dev = authCookieOptions(undefined, { NODE_ENV: "development" });
    expect(dev.secure).toBe(false);
  });
});
