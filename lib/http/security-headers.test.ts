import { describe, expect, it } from "vitest";

import {
  CSP_ENFORCED_HEADER,
  CSP_REPORT_ONLY_HEADER,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  generateNonce,
  isSecureRequest,
} from "./security-headers";

const PROD_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";

const prodInput = (nonce = "n0nce") => ({
  supabaseUrl: PROD_SUPABASE_URL,
  isProd: true,
  nonce,
});

/** Pull a single directive (e.g. "connect-src") out of a CSP string. */
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe("generateNonce", () => {
  it("produces a non-empty value", () => {
    expect(generateNonce().length).toBeGreaterThan(0);
  });

  it("is unique per call (per-request nonce)", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateNonce()));
    expect(seen.size).toBe(100);
  });
});

describe("isSecureRequest", () => {
  it("is true when x-forwarded-proto is https (Cloud Run behind the proxy)", () => {
    expect(isSecureRequest(new Headers({ "x-forwarded-proto": "https" }))).toBe(
      true,
    );
  });

  it("uses the first hop when x-forwarded-proto is a comma list", () => {
    expect(
      isSecureRequest(new Headers({ "x-forwarded-proto": "https, http" })),
    ).toBe(true);
  });

  it("is false for plain http local dev", () => {
    expect(isSecureRequest(new Headers({ "x-forwarded-proto": "http" }))).toBe(
      false,
    );
  });

  it("is false when no proto header is present", () => {
    expect(isSecureRequest(new Headers({}))).toBe(false);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("allows BOTH the supabase https and wss origins in connect-src (Auth + Realtime)", () => {
    const csp = buildContentSecurityPolicy(prodInput());
    const connect = directive(csp, "connect-src")!;
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://abcdefghijklmnop.supabase.co");
    expect(connect).toContain("wss://abcdefghijklmnop.supabase.co");
  });

  it("derives the supabase host from the env url (no hardcoded project ref)", () => {
    const csp = buildContentSecurityPolicy({
      supabaseUrl: "https://zzz-other-ref.supabase.co",
      isProd: true,
      nonce: "n",
    });
    const connect = directive(csp, "connect-src")!;
    expect(connect).toContain("https://zzz-other-ref.supabase.co");
    expect(connect).toContain("wss://zzz-other-ref.supabase.co");
    expect(connect).not.toContain("abcdefghijklmnop");
  });

  it("uses ws/http (not wss/https) for a local http supabase url", () => {
    const csp = buildContentSecurityPolicy({
      supabaseUrl: LOCAL_SUPABASE_URL,
      isProd: false,
      nonce: "n",
    });
    const connect = directive(csp, "connect-src")!;
    expect(connect).toContain("http://127.0.0.1:54321");
    expect(connect).toContain("ws://127.0.0.1:54321");
    expect(connect).not.toContain("wss://127.0.0.1:54321");
  });

  it("carries the per-request nonce in script-src with NO unsafe-inline", () => {
    const csp = buildContentSecurityPolicy(prodInput("abc123"));
    const script = directive(csp, "script-src")!;
    expect(script).toContain("'self'");
    expect(script).toContain("'nonce-abc123'");
    expect(script).not.toContain("unsafe-inline");
  });

  it("permits inline styles only (documented Tailwind/Next exception)", () => {
    const csp = buildContentSecurityPolicy(prodInput());
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
  });

  it("locks down default-src, base-uri, form-action, object-src and frame-ancestors", () => {
    const csp = buildContentSecurityPolicy(prodInput());
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("allows self + data: images (external recipe origins deferred to Slice 1c)", () => {
    const csp = buildContentSecurityPolicy(prodInput());
    expect(directive(csp, "img-src")).toBe("img-src 'self' data:");
  });
});

describe("buildSecurityHeaders", () => {
  it("always sets the enforced baseline headers", () => {
    const headers = buildSecurityHeaders(prodInput());
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("emits the CSP under the Report-Only header name this phase (not enforcing)", () => {
    const headers = buildSecurityHeaders(prodInput());
    expect(headers[CSP_REPORT_ONLY_HEADER]).toContain("default-src 'self'");
    expect(headers[CSP_ENFORCED_HEADER]).toBeUndefined();
  });

  it("sends HSTS ONLY when the prod flag is set", () => {
    const prod = buildSecurityHeaders(prodInput());
    expect(prod["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });

  it("does NOT send HSTS on local (non-prod) http", () => {
    const local = buildSecurityHeaders({
      supabaseUrl: LOCAL_SUPABASE_URL,
      isProd: false,
      nonce: "n",
    });
    expect(local["Strict-Transport-Security"]).toBeUndefined();
    // ...but the report-only CSP still ships locally so we can observe it.
    expect(local[CSP_REPORT_ONLY_HEADER]).toContain("default-src 'self'");
  });
});
