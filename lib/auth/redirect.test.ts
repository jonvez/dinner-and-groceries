import { describe, expect, it } from "vitest";

import { safeRedirectPath } from "./redirect";

describe("safeRedirectPath", () => {
  it("returns the default when next is missing/empty/null", () => {
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath("")).toBe("/");
    expect(safeRedirectPath("   ")).toBe("/");
  });

  it("uses a caller-supplied default", () => {
    expect(safeRedirectPath(null, "/board")).toBe("/board");
  });

  it("allows a same-origin absolute path", () => {
    expect(safeRedirectPath("/board")).toBe("/board");
    expect(safeRedirectPath("/board?week=2026-06-22")).toBe(
      "/board?week=2026-06-22",
    );
    expect(safeRedirectPath("/a/b/c#frag")).toBe("/a/b/c#frag");
  });

  // --- open-redirect defenses -------------------------------------------
  it("rejects absolute URLs to another host", () => {
    expect(safeRedirectPath("https://evil.example.com")).toBe("/");
    expect(safeRedirectPath("http://evil.example.com/path")).toBe("/");
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(safeRedirectPath("//evil.example.com")).toBe("/");
    expect(safeRedirectPath("//evil.example.com/path")).toBe("/");
    // backslash variant some browsers normalize to //
    expect(safeRedirectPath("/\\evil.example.com")).toBe("/");
    expect(safeRedirectPath("\\/evil.example.com")).toBe("/");
  });

  it("rejects anything that does not start with a single slash", () => {
    expect(safeRedirectPath("board")).toBe("/");
    expect(safeRedirectPath("../board")).toBe("/");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/");
    expect(safeRedirectPath("  javascript:alert(1)")).toBe("/");
  });

  it("rejects URLs with an embedded scheme/host after a control char", () => {
    expect(safeRedirectPath("/\thttps://evil.com")).toBe("/");
    expect(safeRedirectPath("/\nhttps://evil.com")).toBe("/");
  });

  it("never returns the login path as a redirect target (no loop)", () => {
    expect(safeRedirectPath("/login")).toBe("/");
    expect(safeRedirectPath("/login?next=/x")).toBe("/");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(safeRedirectPath("  /board  ")).toBe("/board");
  });
});
