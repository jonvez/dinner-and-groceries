import { describe, expect, it } from "vitest";

import { safeHttpUrl } from "./safe-url";

/**
 * `safeHttpUrl` is the scheme-allowlist guard for any user-supplied URL that we
 * persist and later render into an `<a href>` (e.g. a dish's recipe link). React
 * 19 does NOT block `javascript:` / `data:` hrefs, and an input's `type="url"`
 * is a client-only hint — the server action is directly invocable — so the
 * allowlist must be enforced server-side. Mirrors the framework-free, pure,
 * heavily-tested shape of `lib/auth/redirect.ts`.
 */
describe("safeHttpUrl", () => {
  it("accepts http and https URLs (returned as the normalized parsed.href)", () => {
    expect(safeHttpUrl("https://example.com/recipe")).toBe(
      "https://example.com/recipe",
    );
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    expect(safeHttpUrl("  https://example.com/r  ")).toBe(
      "https://example.com/r",
    );
  });

  it("normalizes the returned URL instead of echoing the raw input", () => {
    // No path -> WHATWG parser adds the trailing slash.
    expect(safeHttpUrl("https://example.com")).toBe("https://example.com/");
    // Scheme and host are lowercased; path case is preserved.
    expect(safeHttpUrl("HTTPS://Example.COM/Path")).toBe(
      "https://example.com/Path",
    );
    // Unsafe characters in the path are percent-encoded.
    expect(safeHttpUrl("http://example.com/a b")).toBe(
      "http://example.com/a%20b",
    );
    // The WHATWG URL parser strips ASCII tab/newline before parsing — the
    // returned value must be the normalized href, never the raw input with
    // the control character still embedded.
    const withTab = safeHttpUrl("ht\ttp://example.com");
    expect(withTab).toBe("http://example.com/");
    expect(withTab).not.toContain("\t");
  });

  it("rejects the XSS-bearing javascript: scheme", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("  javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("JavaScript:alert(1)")).toBeNull();
  });

  it("rejects the data: scheme", () => {
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects other non-http(s) schemes", () => {
    expect(safeHttpUrl("ftp://example.com/x")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpUrl("mailto:a@b.com")).toBeNull();
  });

  it("rejects unparseable / relative / empty values", () => {
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("/relative/path")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl("   ")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});
