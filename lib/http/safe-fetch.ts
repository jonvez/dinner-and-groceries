/**
 * SSRF-guarded fetch of a USER-SUPPLIED URL (issue #76, serves #12). The trust
 * boundary between an untrusted recipe URL and our server's network. See
 * docs/superpowers/specs/2026-07-22-safe-fetch-design.md for the threat model.
 *
 * Core defense: the IP we validate is the exact IP we connect to (custom DNS
 * `lookup` threaded into https/http.request), which closes the DNS-rebinding
 * TOCTOU gap. Every redirect hop re-validates. Fails closed on any uncertainty.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

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

/**
 * Node's `net.connect` skips the custom `lookup` entirely when the host is
 * already an IP-address literal (nothing to resolve) — so a URL like
 * `http://127.0.0.1/` or `http://169.254.169.254/` would otherwise connect
 * without ever passing through `makeGuardedLookup`. Strip the `[...]` IPv6
 * bracket syntax the WHATWG `URL` parser leaves on `hostname` and, if what
 * remains is an IP literal, validate it directly here before requesting.
 */
function literalIpAddress(hostname: string): string | null {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0 ? bare : null;
}

function fetchOnce(parsed: URL, blockList: BlockList, timeoutMs: number, maxBytes: number): Promise<OnceResult> {
  return new Promise((resolve) => {
    const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const lookup = makeGuardedLookup(blockList);
    let settled = false;
    const done = (value: SafeFetchResult) => { if (!settled) { settled = true; resolve({ kind: "done", value }); } };
    const redirect = (location: string) => { if (!settled) { settled = true; resolve({ kind: "redirect", location }); } };

    const literal = literalIpAddress(parsed.hostname);
    if (literal && isBlockedAddress(literal, blockList)) { done({ ok: false, reason: "blocked-address" }); return; }

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
