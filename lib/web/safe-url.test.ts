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
  it("accepts http and https URLs (returned trimmed)", () => {
    expect(safeHttpUrl("https://example.com/recipe")).toBe(
      "https://example.com/recipe",
    );
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com");
    expect(safeHttpUrl("  https://example.com/r  ")).toBe(
      "https://example.com/r",
    );
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
