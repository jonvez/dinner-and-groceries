/**
 * Pure, framework-free builders for the app's HTTP security headers (issue #55,
 * subsumes #20). Kept out of the middleware so the policy is asserted in one
 * place and unit-tested without spinning up a request — mirroring how the repo
 * isolates logic in `lib/http/request-origin.ts` and `lib/supabase/*`.
 *
 * ── Rollout phase 2 of 2 (locked by the PO) ──────────────────────────────────
 * The CSP is now **enforcing**: we emit it under `Content-Security-Policy` so
 * the browser blocks violations. Phase 1 shipped the identical policy under
 * `Content-Security-Policy-Report-Only` and prod was observed to produce ZERO
 * organic violations (Next stamps its inline scripts with the per-request
 * nonce, and the allowed `wss://<ref>.supabase.co` Realtime origin is
 * permitted), so flipping the disposition is safe. The directive string itself
 * is unchanged from phase 1 — only the header carrying it changed.
 *
 * Note: the enforced CSP's `frame-ancestors 'none'` now blocks framing on its
 * own, but we keep the (always-enforced) `X-Frame-Options: DENY` header as
 * harmless redundancy — it preserves clickjacking protection for legacy
 * browsers that don't honor `frame-ancestors`.
 */

export const CSP_ENFORCED_HEADER = "Content-Security-Policy";
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

const HSTS_VALUE = "max-age=63072000; includeSubDomains";

export type SecurityHeadersInput = {
  /** `NEXT_PUBLIC_SUPABASE_URL` — used to derive the CSP `connect-src` allow-list. */
  supabaseUrl: string;
  /** True for deployed HTTPS requests; gates HSTS (never sent on local http). */
  isProd: boolean;
  /** Per-request base64 nonce; goes into `script-src` and Next's own scripts. */
  nonce: string;
};

/**
 * Generate a per-request nonce for the nonce-based `script-src`. Uses the Web
 * Crypto global (available in both the Edge middleware runtime and Node) so it
 * works wherever the middleware executes.
 */
export function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

/**
 * Is this request being served over HTTPS? Behind Cloud Run the TLS terminates
 * at the proxy, so the reliable signal is `x-forwarded-proto` (which may be a
 * comma-separated hop list — the client-facing scheme is the first entry), not
 * `NODE_ENV`. HSTS is only meaningful (and only safe to send) over HTTPS, so
 * this is what gates it.
 */
export function isSecureRequest(headers: Headers): boolean {
  const proto = headers.get("x-forwarded-proto") ?? "";
  return proto.split(",")[0]!.trim().toLowerCase() === "https";
}

/**
 * Derive the Supabase origins to allow in `connect-src` from the public URL.
 * Supabase Auth/PostgREST use https(http locally); Realtime uses wss(ws
 * locally) to the SAME host. We build both from the URL's host — never a
 * hardcoded project ref — so this tracks whichever project the env var points
 * at. If either is blocked the social loop dies, so both are required.
 */
function supabaseConnectSources(supabaseUrl: string): string[] {
  const { protocol, host } = new URL(supabaseUrl);
  const secure = protocol === "https:";
  return [
    `${secure ? "https" : "http"}://${host}`,
    `${secure ? "wss" : "ws"}://${host}`,
  ];
}

/**
 * Build the Content-Security-Policy string. Real nonce-based policy — no
 * blanket `unsafe-inline`/`*` for scripts that would defeat it.
 */
export function buildContentSecurityPolicy(input: SecurityHeadersInput): string {
  const connectSrc = ["'self'", ...supabaseConnectSources(input.supabaseUrl)];

  const directives = [
    `default-src 'self'`,
    // Nonce-based scripts only. NO `unsafe-inline` — the nonce is what makes the
    // policy meaningful. Next stamps the same nonce onto its own <script> tags
    // (it reads it from the request CSP header — see lib/supabase/middleware.ts).
    `script-src 'self' 'nonce-${input.nonce}'`,
    // Documented exception (Security DoD): styles allow 'unsafe-inline'. Tailwind
    // and Next inject inline <style>/style="" that a style nonce can't cover
    // practically, and the XSS risk from inline STYLES is far lower than from
    // inline scripts (which remain locked to the nonce above).
    `style-src 'self' 'unsafe-inline'`,
    // Auth (https) + Realtime (wss) to the hosted Supabase origin. Make-or-break
    // for the social loop; derived from the env URL, never a hardcoded ref.
    `connect-src ${connectSrc.join(" ")}`,
    // Self-hosted + inline data: images only. External recipe-image origins are
    // deferred until Slice 1c (recipe URL fetch) actually lands.
    `img-src 'self' data:`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
  ];

  return directives.join("; ");
}

/**
 * Build the full security-header set for a response.
 *
 * Enforced (always): X-Content-Type-Options, Referrer-Policy, X-Frame-Options,
 * and HSTS (prod only). The CSP ships this phase under the **enforcing**
 * header name (see the module doc for the rollout rationale).
 */
export function buildSecurityHeaders(
  input: SecurityHeadersInput,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Redundant with the now-enforced CSP `frame-ancestors 'none'`, but kept as
    // harmless belt-and-suspenders protection for legacy browsers that ignore
    // `frame-ancestors`.
    "X-Frame-Options": "DENY",
    [CSP_ENFORCED_HEADER]: buildContentSecurityPolicy(input),
  };

  // HSTS: production/HTTPS only. Never sent on local http dev, where it would
  // wrongly pin the browser to HTTPS for localhost.
  if (input.isProd) {
    headers["Strict-Transport-Security"] = HSTS_VALUE;
  }

  return headers;
}
