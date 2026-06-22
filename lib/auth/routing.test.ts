import { describe, expect, it } from "vitest";

import { resolveAuthRoute, isPublicPath } from "./routing";

describe("isPublicPath", () => {
  it("treats the login page and auth endpoints as public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/auth/signout")).toBe(true);
  });

  it("treats everything else as protected", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/board")).toBe(false);
    expect(isPublicPath("/join")).toBe(false);
  });
});

describe("resolveAuthRoute", () => {
  // --- signed-out visitor on a protected route -> login -------------------
  it("redirects a signed-out visitor on a protected route to /login with next", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: false,
        hasMember: false,
        pathname: "/board",
      }),
    ).toEqual({ action: "redirect", to: "/login?next=%2Fboard" });
  });

  it("redirects a signed-out visitor on the root to /login", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: false,
        hasMember: false,
        pathname: "/",
      }),
    ).toEqual({ action: "redirect", to: "/login?next=%2F" });
  });

  it("lets a signed-out visitor stay on the public login page", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: false,
        hasMember: false,
        pathname: "/login",
      }),
    ).toEqual({ action: "next" });
  });

  it("lets the OAuth callback through even when signed-out (it establishes the session)", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: false,
        hasMember: false,
        pathname: "/auth/callback",
      }),
    ).toEqual({ action: "next" });
  });

  // --- signed-in WITHOUT a member row -> the join flow --------------------
  it("routes a signed-in user with no member row to /join", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: false,
        pathname: "/board",
      }),
    ).toEqual({ action: "redirect", to: "/join" });
  });

  it("does not loop a no-member user who is already on /join", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: false,
        pathname: "/join",
      }),
    ).toEqual({ action: "next" });
  });

  it("lets a no-member user land on an invite link /join/<token> (token preserved)", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: false,
        pathname: "/join/abc123",
      }),
    ).toEqual({ action: "next" });
  });

  it("sends a signed-in no-member user away from /login to /join", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: false,
        pathname: "/login",
      }),
    ).toEqual({ action: "redirect", to: "/join" });
  });

  // --- signed-in WITH a member row ---------------------------------------
  it("lets a fully signed-in member proceed on a protected route", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: true,
        pathname: "/board",
      }),
    ).toEqual({ action: "next" });
  });

  it("sends a signed-in member away from /login to their next (or home)", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: true,
        pathname: "/login",
        next: "/board",
      }),
    ).toEqual({ action: "redirect", to: "/board" });
  });

  it("ignores an unsafe next when bouncing a signed-in member off /login", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: true,
        pathname: "/login",
        next: "https://evil.example.com",
      }),
    ).toEqual({ action: "redirect", to: "/" });
  });

  it("sends a signed-in member away from /join (they already have a household) to home", () => {
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: true,
        pathname: "/join",
      }),
    ).toEqual({ action: "redirect", to: "/" });
  });

  it("sends a signed-in member away from an invite link /join/<token> to home", () => {
    // They already belong to a household; the single-household invariant means
    // an invite link is a no-op for them — bounce home rather than show join UI.
    expect(
      resolveAuthRoute({
        isAuthenticated: true,
        hasMember: true,
        pathname: "/join/abc123",
      }),
    ).toEqual({ action: "redirect", to: "/" });
  });
});
