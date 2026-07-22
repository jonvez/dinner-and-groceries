# SSRF-Guarded URL Fetcher — Design Spec (#76, serves #12)

- **Date:** 2026-07-22
- **Issue:** #76 — `Fetch a pasted recipe URL without becoming an SSRF vector — safe-fetch (lib, Node built-ins, security-reviewed)`
- **Serves:** #12 (recipe ingestion — this is the security-critical piece split out for a focused review)
- **Authorities:** SPEC.md (Recipe Ingestion Mechanics), ADR 0003 (SSRF rules), TEAM.md (security-relevant DoD)
- **Status:** Approved (Jon, 2026-07-22) — ready for implementation plan

## Purpose

A `lib/` function that fetches a **user-supplied** URL and returns its HTML, without
letting a malicious or attacker-controlled URL reach internal, loopback, link-local, or
cloud-metadata endpoints. Recipe ingestion (#12) hands untrusted URLs straight to this
function, so it is the app's SSRF trust boundary.

Returns a typed **result**, never throws, so #12 branches cleanly to its manual-editor
fallback on any failure.

## Threat model (what the guard must close)

1. URL pointing **directly** at a private/loopback/link-local/metadata IP —
   `169.254.169.254` (cloud metadata), `127.0.0.1`, `10/8`, `172.16/12`, `192.168/16`,
   IPv6 `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), IPv4-mapped IPv6, etc.
2. A **hostname that resolves** to any of the above (attacker-controlled DNS).
3. **DNS rebinding (TOCTOU):** resolves to a public IP at check time, a private IP at
   connect time.
4. **Redirects** into any of the above (incl. cross-protocol http↔https).
5. Non-`http(s)` **schemes** (`file:`, `gopher:`, `data:`, …).
6. **Resource exhaustion:** oversized responses, slow responses, redirect loops.

## Core mechanism — validate the connected IP, at connect time

The defense is that **the IP we validate is the exact IP we connect to** — which closes
the rebinding TOCTOU gap. Node's low-level `https.request`/`http.request` accept a
`lookup` option that is threaded to the socket's `net.connect`. We pass a **custom
`lookup`** that:

1. Delegates to `dns.lookup` (with `all: true` to see every resolved address).
2. Runs each resolved IP through a `net.BlockList` preloaded with the reserved CIDR
   ranges (native, correct IPv4/IPv6 subnet math — no hand-rolled bit-masking).
3. If **any** resolved address is blocked, the lookup errors → the connection never
   opens. Otherwise it returns the (already-validated) address the socket will use.

Because the socket connects to exactly the address the custom `lookup` returned, there is
no window for a second DNS answer to swap in a private IP.

Redirects are followed **manually**: on a 3xx with a `Location`, we re-invoke the same
guarded request against the new URL — so every hop re-runs scheme validation **and** the
custom-`lookup` IP validation. Redirect depth is capped.

> **Why not global `fetch`/undici?** Node's global `fetch` does not accept an
> `http.Agent`/`lookup`, so it can't pin the validated IP to the connection. `https.request`
> with `lookup` can. This is a deliberate choice, not an oversight.

## Reserved-range blocklist (the CIDR table)

A single constant table of reserved CIDRs loaded into a `net.BlockList`, covering at
minimum:

- **IPv4:** `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`,
  `169.254.0.0/16` (link-local + metadata), `172.16.0.0/12`, `192.0.0.0/24`,
  `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4` (multicast), `240.0.0.0/4` (reserved).
- **IPv6:** `::1/128` (loopback), `::/128` (unspecified), `::ffff:0:0/96` (IPv4-mapped —
  must also be decoded and its embedded IPv4 re-checked), `fc00::/7` (ULA),
  `fe80::/10` (link-local), `ff00::/8` (multicast), `2001:db8::/32` (documentation),
  `64:ff9b::/96` (NAT64 — maps to embedded IPv4, re-check).
- The exact table is finalized during implementation, test-driven from a case table; it
  lives in one place and is trivially extended.

**IPv4-mapped / translated IPv6 caveat (call out in the security review):** an address
like `::ffff:127.0.0.1` or a NAT64 form embeds an IPv4 address; the guard must decode and
re-check the embedded IPv4 against the IPv4 ranges, not just match the IPv6 prefix.

## API surface

`lib/http/safe-fetch.ts` (generic, security-domain — alongside `request-origin.ts` /
`security-headers.ts`).

```ts
export type SafeFetchResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; reason: SafeFetchFailure };

export type SafeFetchFailure =
  | "bad-scheme"        // not http/https
  | "blocked-address"   // resolved to a reserved/private/metadata IP (any hop)
  | "not-html"          // Content-Type is not HTML
  | "too-large"         // body exceeded the size cap
  | "timeout"           // exceeded the time cap
  | "too-many-redirects"// exceeded the redirect cap
  | "unreachable";      // DNS/connection error, non-2xx after redirects, etc.

export async function safeFetchHtml(
  url: string,
  options?: SafeFetchOptions,
): Promise<SafeFetchResult>;
```

- **`options` exists for testability** (see below): an injectable blocklist / allowance
  so tests can permit loopback, and overridable caps. Production callers pass nothing and
  get the secure defaults.
- Never throws for expected failure modes — all map to an `ok: false` reason. (A truly
  unexpected internal error may reject; #12's caller treats a rejection as `unreachable`.)

## Caps (tunable constants, ADR-0003 style — one place)

| Cap | Default | Failure reason |
|---|---|---|
| Total timeout | **5 s** | `timeout` |
| Max body size | **2 MB** (abort the stream once exceeded) | `too-large` |
| Max redirects | **3** | `too-many-redirects` |
| Schemes | `http`, `https` only | `bad-scheme` |
| Content-Type | must be HTML (`text/html`, `application/xhtml+xml`) | `not-html` |

Rationale for **3** redirects: legitimate flows (http→https, www-canonicalization, a
locale hop) fit within 3; more indicates shortener-chaining or evasion. Accepted
tradeoff: a multi-hop shortened link may exceed it (user can paste the resolved URL).

## Runtime

Pure Node module using `node:https` / `node:http` / `node:dns` / `node:net`. The Next.js
route that calls it (built in #12) **must** declare `export const runtime = "nodejs"` —
these built-ins are unavailable on the Edge runtime.

## Design for testability (critical — the happy path is otherwise untestable)

Every local test server binds to `127.0.0.1`, which the guard **blocks**. So the module is
split so both halves are testable:

1. **The IP guard** — `isBlockedAddress(ip: string): boolean` and the custom `lookup` —
   is a **separable unit, exhaustively table-tested with no network**: every reserved
   range (v4 + v6 + IPv4-mapped) asserts blocked; representative public IPs assert
   allowed. This is the security-critical logic and gets the most cases.
2. **The fetch/redirect/caps orchestration** is tested against a **loopback HTTP test
   server**, with the blocklist **injected via `options`** so tests may permit
   `127.0.0.1`. These tests cover: happy-path HTML return, redirect-following up to the
   cap, over-cap redirect → `too-many-redirects`, oversized body → `too-large`, slow
   response → `timeout`, non-HTML content-type → `not-html`, non-http scheme →
   `bad-scheme`, and a redirect whose target is blocked → `blocked-address` (guard
   re-runs per hop).

The injectable seam is production-safe: the default (no options) is fully locked down;
only tests pass an allowance, and that is asserted by a test confirming the **default**
blocks loopback.

## Testing strategy (strict test-first — TEAM.md security DoD)

- Write the `isBlockedAddress` case table first (watch fail), implement, pass.
- Then the orchestration tests against the loopback server (watch fail), implement, pass.
- Lint/typecheck clean; PR linked to #76.
- **Non-author security-review** over the fetcher (SSRF / input validation), with the
  IPv4-mapped/NAT64 decoding and the per-hop redirect re-validation explicitly on its
  checklist.
- QA verifies the block paths and the typed-result fallback; PO accepts against #76 AC.

## Out of scope (this issue)
- JSON-LD extraction, dish/ingredient persistence, the manual editor, the ingest server
  action — all **#12**, which consumes this function.
- Caching, robots.txt/politeness, authentication to remote sites, non-HTML extraction.
- POST/PUT or any method other than GET.
