# SSRF-Guarded URL Fetcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `lib/http/safe-fetch.ts` function that fetches a user-supplied URL's HTML while blocking SSRF (private/loopback/link-local/metadata IPs, DNS rebinding, redirect-based bypass, non-http schemes, resource exhaustion).

**Architecture:** Three layers, each independently testable: (1) `isBlockedAddress` — reserved-range classification over a native `net.BlockList`, incl. IPv4-mapped/NAT64 decode; (2) a custom DNS `lookup` that runs every resolved IP through (1) so the validated IP is the connected IP (rebinding-safe); (3) `safeFetchHtml` — the request/manual-redirect/caps orchestration returning a typed result. The blocklist is injectable so the loopback happy-path is testable.

**Tech Stack:** TypeScript, Vitest, Node built-ins only (`node:https`, `node:http`, `node:dns`, `node:net`). **No new npm dependency.**

**Design spec:** `docs/superpowers/specs/2026-07-22-safe-fetch-design.md` (read it first — especially the threat model and the IPv4-mapped caveat).

## Global Constraints

- **Node built-ins only; no new npm dependency.** — #76 AC.
- **Validate the connected IP at connect time** (custom `lookup`), never a separate earlier resolve — this is what defeats DNS rebinding. — design spec.
- **Every redirect hop re-runs scheme + IP validation.** — #76 AC.
- **Fail closed:** an unparseable IP, a lookup error, or any uncertainty → treat as blocked/unreachable, never as allowed. — design spec.
- **Typed discriminated-union result, never throw** for expected failures. — #76 AC.
- **Caps (defaults, overridable only via options for tests):** timeout **5000 ms**, max body **2 MB** (`2 * 1024 * 1024`), max redirects **3**, schemes `http`/`https` only, Content-Type must be `text/html` or `application/xhtml+xml`.
- **Blocklist is injectable** via `options.blockList`; default is the reserved-range list. A test MUST assert the default blocks `127.0.0.1`.
- **`lib/` style (match `lib/http/request-origin.ts`):** named exports, doc comments explaining the "why", pure/deterministic where possible.
- **Strict test-first**; the `isBlockedAddress` case table is written and watched fail before implementation. — TEAM.md security DoD.

---

### Task 1: `isBlockedAddress` + reserved-range blocklist (the security core)

**Files:**
- Create: `lib/http/safe-fetch.ts`
- Test: `lib/http/safe-fetch.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function isBlockedAddress(ip: string, blockList?: BlockList): boolean` — true if `ip` is in a reserved range (or is not a valid IP). IPv4-mapped/NAT64 IPv6 addresses have their embedded IPv4 decoded and re-checked.
  - `function buildReservedBlockList(): BlockList` — the default reserved-CIDR `net.BlockList`.

- [ ] **Step 1: Write the failing tests** (exhaustive case table)

Create `lib/http/safe-fetch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isBlockedAddress } from "./safe-fetch";

describe("isBlockedAddress", () => {
  it("blocks IPv4 reserved/private/loopback/metadata ranges", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 reserved/loopback/link-local/ULA", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false); // cloudflare
  });

  it("blocks IPv4-mapped and NAT64 IPv6 by decoding the embedded IPv4", () => {
    for (const ip of [
      "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1",
      "64:ff9b::7f00:1",   // NAT64 of 127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows an IPv4-mapped public address", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("fails closed on garbage input", () => {
    for (const bad of ["", "not-an-ip", "999.999.999.999", "127.0.0.1.5"]) {
      expect(isBlockedAddress(bad), bad).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/http/safe-fetch.test.ts -t isBlockedAddress`
Expected: FAIL — `isBlockedAddress` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `lib/http/safe-fetch.ts`:

```ts
/**
 * SSRF-guarded fetch of a USER-SUPPLIED URL (issue #76, serves #12). The trust
 * boundary between an untrusted recipe URL and our server's network. See
 * docs/superpowers/specs/2026-07-22-safe-fetch-design.md for the threat model.
 *
 * Core defense: the IP we validate is the exact IP we connect to (custom DNS
 * `lookup` threaded into https/http.request), which closes the DNS-rebinding
 * TOCTOU gap. Every redirect hop re-validates. Fails closed on any uncertainty.
 */
import { BlockList, isIP } from "node:net";

/** Reserved CIDR ranges we refuse to connect to. Native BlockList = correct subnet math. */
export function buildReservedBlockList(): BlockList {
  const bl = new BlockList();
  // IPv4
  bl.addSubnet("0.0.0.0", 8, "ipv4");
  bl.addSubnet("10.0.0.0", 8, "ipv4");
  bl.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
  bl.addSubnet("127.0.0.0", 8, "ipv4");   // loopback
  bl.addSubnet("169.254.0.0", 16, "ipv4"); // link-local + cloud metadata
  bl.addSubnet("172.16.0.0", 12, "ipv4");
  bl.addSubnet("192.0.0.0", 24, "ipv4");
  bl.addSubnet("192.168.0.0", 16, "ipv4");
  bl.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
  bl.addSubnet("224.0.0.0", 4, "ipv4");   // multicast
  bl.addSubnet("240.0.0.0", 4, "ipv4");   // reserved (incl. 255.255.255.255)
  // IPv6
  bl.addAddress("::1", "ipv6");           // loopback
  bl.addAddress("::", "ipv6");            // unspecified
  bl.addSubnet("fc00::", 7, "ipv6");      // unique-local
  bl.addSubnet("fe80::", 10, "ipv6");     // link-local
  bl.addSubnet("ff00::", 8, "ipv6");      // multicast
  bl.addSubnet("2001:db8::", 32, "ipv6"); // documentation
  return bl;
}

const RESERVED = buildReservedBlockList();

/**
 * Decode the embedded IPv4 from an IPv4-mapped (`::ffff:a.b.c.d` / `::ffff:xxxx:xxxx`)
 * or NAT64 (`64:ff9b::/96`) IPv6 address, so its real destination is re-checked
 * against the IPv4 ranges. Returns null if there is no embedded IPv4.
 */
function embeddedIPv4(ipv6: string): string | null {
  const addr = ipv6.toLowerCase();
  // Dotted form: ::ffff:127.0.0.1 or ::127.0.0.1
  const dotted = addr.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted && isIP(dotted[1]) === 4) return dotted[1];
  // Hex form for ::ffff:/96 and 64:ff9b::/96 — last two hextets carry the IPv4.
  if (addr.startsWith("::ffff:") || addr.startsWith("64:ff9b::")) {
    const hextets = addr.split(":");
    const last2 = hextets.slice(-2);
    if (last2.length === 2 && /^[0-9a-f]{1,4}$/.test(last2[0]) && /^[0-9a-f]{1,4}$/.test(last2[1])) {
      const a = parseInt(last2[0], 16);
      const b = parseInt(last2[1], 16);
      return `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
    }
  }
  return null;
}

/**
 * True if `ip` must not be connected to (reserved range) — or if it is not a valid
 * IP at all (fail closed). IPv4-mapped/NAT64 IPv6 is decoded and re-checked.
 */
export function isBlockedAddress(ip: string, blockList: BlockList = RESERVED): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // not a valid IP → fail closed
  if (family === 4) return blockList.check(ip, "ipv4");
  // family === 6
  const v4 = embeddedIPv4(ip);
  if (v4) return isBlockedAddress(v4, blockList) || blockList.check(ip, "ipv6");
  return blockList.check(ip, "ipv6");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/http/safe-fetch.test.ts -t isBlockedAddress`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/http/safe-fetch.ts lib/http/safe-fetch.test.ts
git commit -m "feat(http): reserved-range blocklist + isBlockedAddress with IPv4-mapped decode (#76)"
```

---

### Task 2: `makeGuardedLookup` — connection-time IP validation

**Files:**
- Modify: `lib/http/safe-fetch.ts`
- Test: `lib/http/safe-fetch.test.ts`

**Interfaces:**
- Consumes: `isBlockedAddress` (Task 1).
- Produces: `function makeGuardedLookup(blockList: BlockList, resolver?): LookupFunction` — a `net`-compatible `lookup(hostname, options, callback)` that resolves ALL addresses, calls back with an `EBLOCKED` error if any is blocked, else returns validated address(es). `resolver` is injectable (default `node:dns` `lookup`) for deterministic tests.

- [ ] **Step 1: Write the failing tests**

Append to `lib/http/safe-fetch.test.ts`:

```ts
import { makeGuardedLookup, buildReservedBlockList } from "./safe-fetch";

// A fake resolver so we can drive resolved IPs deterministically (no network).
function fakeResolver(map: Record<string, Array<{ address: string; family: number }>>) {
  return (hostname: string, _opts: unknown, cb: (e: Error | null, a: unknown, f?: number) => void) => {
    const rec = map[hostname];
    if (!rec) { const e = new Error("ENOTFOUND") as NodeJS.ErrnoException; e.code = "ENOTFOUND"; cb(e, "", 0); return; }
    cb(null, rec, undefined); // `all: true` shape
  };
}

describe("makeGuardedLookup", () => {
  const bl = buildReservedBlockList();

  it("passes through a public address", async () => {
    const lookup = makeGuardedLookup(bl, fakeResolver({ "example.com": [{ address: "93.184.216.34", family: 4 }] }));
    const out = await new Promise<{ err: Error | null; address: string }>((resolve) =>
      lookup("example.com", { all: false } as never, (err, address) => resolve({ err, address: address as string })));
    expect(out.err).toBeNull();
    expect(out.address).toBe("93.184.216.34");
  });

  it("rejects with EBLOCKED when a resolved address is reserved (rebinding defense)", async () => {
    const lookup = makeGuardedLookup(bl, fakeResolver({ "evil.test": [{ address: "169.254.169.254", family: 4 }] }));
    const out = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup("evil.test", { all: false } as never, (err) => resolve(err as NodeJS.ErrnoException)));
    expect(out?.code).toBe("EBLOCKED");
  });

  it("rejects when ANY of several resolved addresses is reserved", async () => {
    const lookup = makeGuardedLookup(bl, fakeResolver({
      "mixed.test": [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
    }));
    const out = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup("mixed.test", { all: false } as never, (err) => resolve(err as NodeJS.ErrnoException)));
    expect(out?.code).toBe("EBLOCKED");
  });

  it("propagates a resolver (DNS) error as unreachable", async () => {
    const lookup = makeGuardedLookup(bl, fakeResolver({}));
    const out = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup("nope.test", { all: false } as never, (err) => resolve(err as NodeJS.ErrnoException)));
    expect(out?.code).toBe("ENOTFOUND");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/http/safe-fetch.test.ts -t makeGuardedLookup`
Expected: FAIL — `makeGuardedLookup` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/http/safe-fetch.ts`:

```ts
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

type ResolverFn = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `net`-compatible custom `lookup` that validates EVERY resolved address before
 * the socket connects. If any is blocked, it errors with `EBLOCKED` and the
 * connection never opens — so the IP validated is the IP connected to (rebinding
 * defense). `resolver` is injectable for tests; production uses `node:dns` lookup.
 */
export function makeGuardedLookup(
  blockList: BlockList,
  resolver: ResolverFn = dnsLookup as unknown as ResolverFn,
): LookupFunction {
  return ((hostname, options, callback) => {
    resolver(hostname, { all: true }, (err, addresses) => {
      if (err) { (callback as (e: NodeJS.ErrnoException) => void)(err); return; }
      for (const a of addresses) {
        if (isBlockedAddress(a.address, blockList)) {
          const e = new Error(`blocked address for ${hostname}: ${a.address}`) as NodeJS.ErrnoException;
          e.code = "EBLOCKED";
          (callback as (e: NodeJS.ErrnoException) => void)(e);
          return;
        }
      }
      const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (wantsAll) { (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses); return; }
      callback(null, addresses[0].address, addresses[0].family);
    }) as never;
  }) as LookupFunction;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/http/safe-fetch.test.ts -t makeGuardedLookup`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/http/safe-fetch.ts lib/http/safe-fetch.test.ts
git commit -m "feat(http): connection-time guarded DNS lookup (rebinding defense) (#76)"
```

---

### Task 3: `safeFetchHtml` — request/redirect/caps orchestration

**Files:**
- Modify: `lib/http/safe-fetch.ts`
- Test: `lib/http/safe-fetch.test.ts`

**Interfaces:**
- Consumes: `makeGuardedLookup` (Task 2), `buildReservedBlockList`/`RESERVED` (Task 1).
- Produces:
  - `type SafeFetchResult` and `type SafeFetchFailure` (see spec).
  - `type SafeFetchOptions = { blockList?: BlockList; timeoutMs?: number; maxBytes?: number; maxRedirects?: number }`.
  - `function safeFetchHtml(url: string, options?: SafeFetchOptions): Promise<SafeFetchResult>` — the public entry point.

- [ ] **Step 1: Write the failing tests**

Append to `lib/http/safe-fetch.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import { BlockList, type AddressInfo } from "node:net";
import { safeFetchHtml } from "./safe-fetch";

// Empty blocklist → allows loopback so the happy path is testable.
const allowLoopback = () => new BlockList();

function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe("safeFetchHtml", () => {
  it("returns HTML on the happy path", async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>hi</body></html>");
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: allowLoopback() });
    server.close();
    expect(r).toEqual({ ok: true, html: "<html><body>hi</body></html>", finalUrl: `http://127.0.0.1:${port}/` });
  });

  it("blocks 127.0.0.1 with the DEFAULT blocklist (seam is production-safe)", async () => {
    const { server, port } = await listen((_req, res) => { res.end("nope"); });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`); // no options → default reserved list
    server.close();
    expect(r).toEqual({ ok: false, reason: "blocked-address" });
  });

  it("rejects a non-http(s) scheme", async () => {
    expect(await safeFetchHtml("file:///etc/passwd")).toEqual({ ok: false, reason: "bad-scheme" });
    expect(await safeFetchHtml("gopher://x/")).toEqual({ ok: false, reason: "bad-scheme" });
  });

  it("rejects non-HTML content types", async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: allowLoopback() });
    server.close();
    expect(r).toEqual({ ok: false, reason: "not-html" });
  });

  it("enforces the size cap", async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("x".repeat(5000));
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: allowLoopback(), maxBytes: 1000 });
    server.close();
    expect(r).toEqual({ ok: false, reason: "too-large" });
  });

  it("follows redirects up to the cap", async () => {
    const { server, port } = await listen((req, res) => {
      if (req.url === "/final") { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>ok</p>"); return; }
      const n = Number(req.url!.slice(1) || "0");
      res.writeHead(302, { location: n >= 1 ? "/final" : "/1" }); res.end();
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/0`, { blockList: allowLoopback(), maxRedirects: 3 });
    server.close();
    expect(r).toEqual({ ok: true, html: "<p>ok</p>", finalUrl: `http://127.0.0.1:${port}/final` });
  });

  it("fails when redirects exceed the cap", async () => {
    const { server, port } = await listen((_req, res) => { res.writeHead(302, { location: "/loop" }); res.end(); });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: allowLoopback(), maxRedirects: 2 });
    server.close();
    expect(r).toEqual({ ok: false, reason: "too-many-redirects" });
  });

  it("re-validates each redirect hop and blocks a redirect to a reserved IP", async () => {
    // Block only 169.254/16 so the loopback first hop is allowed but the redirect target is not.
    const bl = new BlockList();
    bl.addSubnet("169.254.0.0", 16, "ipv4");
    const { server, port } = await listen((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end();
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: bl });
    server.close();
    expect(r).toEqual({ ok: false, reason: "blocked-address" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/http/safe-fetch.test.ts -t safeFetchHtml`
Expected: FAIL — `safeFetchHtml` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/http/safe-fetch.ts`:

```ts
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export type SafeFetchFailure =
  | "bad-scheme" | "blocked-address" | "not-html"
  | "too-large" | "timeout" | "too-many-redirects" | "unreachable";

export type SafeFetchResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; reason: SafeFetchFailure };

export type SafeFetchOptions = {
  blockList?: BlockList;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

type OnceResult = { kind: "redirect"; location: string } | { kind: "done"; value: SafeFetchResult };

function fetchOnce(parsed: URL, blockList: BlockList, timeoutMs: number, maxBytes: number): Promise<OnceResult> {
  return new Promise((resolve) => {
    const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const lookup = makeGuardedLookup(blockList);
    let settled = false;
    const done = (value: SafeFetchResult) => { if (!settled) { settled = true; resolve({ kind: "done", value }); } };
    const redirect = (location: string) => { if (!settled) { settled = true; resolve({ kind: "redirect", location }); } };

    const req = requestFn(parsed, { method: "GET", lookup, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); redirect(res.headers.location); return; }
      if (status < 200 || status >= 300) { res.resume(); done({ ok: false, reason: "unreachable" }); return; }
      const ctype = String(res.headers["content-type"] ?? "").toLowerCase();
      if (!ctype.includes("text/html") && !ctype.includes("application/xhtml+xml")) {
        res.resume(); done({ ok: false, reason: "not-html" }); return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) { req.destroy(); done({ ok: false, reason: "too-large" }); return; }
        chunks.push(c);
      });
      res.on("end", () => done({ ok: true, html: Buffer.concat(chunks).toString("utf8"), finalUrl: parsed.toString() }));
      res.on("error", () => done({ ok: false, reason: "unreachable" }));
    });
    req.on("timeout", () => { req.destroy(); done({ ok: false, reason: "timeout" }); });
    req.on("error", (err: NodeJS.ErrnoException) => {
      done({ ok: false, reason: err?.code === "EBLOCKED" ? "blocked-address" : "unreachable" });
    });
    req.end();
  });
}

/**
 * Fetch a user-supplied URL's HTML, blocking SSRF. Returns a typed result; never
 * throws for expected failures. Every redirect hop re-validates scheme + IP.
 */
export async function safeFetchHtml(url: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const blockList = options.blockList ?? RESERVED;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { return { ok: false, reason: "unreachable" }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "bad-scheme" };

    const once = await fetchOnce(parsed, blockList, timeoutMs, maxBytes);
    if (once.kind === "done") return once.value;
    try { current = new URL(once.location, parsed).toString(); } catch { return { ok: false, reason: "unreachable" }; }
  }
  return { ok: false, reason: "too-many-redirects" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/http/safe-fetch.test.ts -t safeFetchHtml`
Expected: PASS (all 8 orchestration cases).

- [ ] **Step 5: Commit**

```bash
git add lib/http/safe-fetch.ts lib/http/safe-fetch.test.ts
git commit -m "feat(http): safeFetchHtml orchestration — redirects, caps, typed result (#76)"
```

---

### Task 4: Full-suite verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: PASS — the new `lib/http/safe-fetch.test.ts` suite passes alongside all existing suites (no regressions).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (The `LookupFunction`/`callback` casts in Task 2 are deliberate — Node's `lookup` overloads don't narrow cleanly; if `tsc` flags one, prefer a localized cast over `any`-widening the whole function.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Confirm the public surface**

Verify `lib/http/safe-fetch.ts` exports: `safeFetchHtml`, `SafeFetchResult`, `SafeFetchFailure`, `SafeFetchOptions` (public), plus `isBlockedAddress`, `makeGuardedLookup`, `buildReservedBlockList` (tested building blocks). No default export.

- [ ] **Step 5: Commit any lint/typecheck fixups (if needed)**

```bash
git add lib/http/safe-fetch.ts lib/http/safe-fetch.test.ts
git commit -m "chore(http): lint/typecheck clean-up for safe-fetch (#76)"
```

---

## Notes for the PR (developer)

- PR title: `feat(http): SSRF-guarded URL fetcher (#76)`; body includes `Closes #76`, links the design spec, and the verification output.
- Required checks on `main` must be green: "Lint, typecheck, unit tests", "Playwright smoke E2E", "RLS pgTAP (Supabase)". This change touches no routes/DB, so E2E + pgTAP are unaffected.
- **This PR triggers the non-author security-review gate** (#76 DoD). Flag for the reviewer's checklist: (a) IPv4-mapped/NAT64 decode in `embeddedIPv4` — try to find a bypass; (b) the custom `lookup` validates ALL resolved addresses, not just the first; (c) per-hop re-validation on redirects (incl. cross-protocol http↔https); (d) fail-closed on parse/lookup errors; (e) the injectable-blocklist seam cannot weaken production defaults (the default-blocks-loopback test proves it).
- Do NOT merge — Jon approves and merges every PR.
