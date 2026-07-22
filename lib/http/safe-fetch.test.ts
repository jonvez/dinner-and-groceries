import { describe, it, expect } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { type LookupAddress } from "node:dns";
import { BlockList, type AddressInfo } from "node:net";
import { isBlockedAddress, makeGuardedLookup, buildReservedBlockList, safeFetchHtml } from "./safe-fetch";

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

// A fake resolver so we can drive resolved IPs deterministically (no network).
function fakeResolver(map: Record<string, LookupAddress[]>) {
  return (
    hostname: string,
    _opts: { all: true },
    cb: (e: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ) => {
    const rec = map[hostname];
    if (!rec) { const e = new Error("ENOTFOUND") as NodeJS.ErrnoException; e.code = "ENOTFOUND"; cb(e, []); return; }
    cb(null, rec); // `all: true` shape
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

// Empty blocklist → allows loopback so the happy path is testable.
const allowLoopback = () => new BlockList();

function listen(handler: RequestListener): Promise<{ server: Server; port: number }> {
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

  // --- QA edge cases (#76) ---

  it("times out on a slow/non-responding server (5s cap, overridden here for speed)", async () => {
    const { server, port } = await listen((_req, res) => {
      // Never writes a response — socket stays open past the timeout.
      setTimeout(() => res.end("too late"), 2000);
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: allowLoopback(), timeoutMs: 100 });
    server.close();
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });

  it("rejects malformed/empty URLs as unreachable rather than throwing", async () => {
    expect(await safeFetchHtml("")).toEqual({ ok: false, reason: "unreachable" });
    expect(await safeFetchHtml("not a url at all")).toEqual({ ok: false, reason: "unreachable" });
    expect(await safeFetchHtml("   ")).toEqual({ ok: false, reason: "unreachable" });
  });

  it("treats a missing Content-Type header as not-html", async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, {}); // no content-type at all
      res.end("<html></html>");
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: allowLoopback() });
    server.close();
    expect(r).toEqual({ ok: false, reason: "not-html" });
  });

  it("accepts an uppercase/mixed-case scheme (WHATWG URL normalizes before the scheme check)", async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>hi</p>");
    });
    const r = await safeFetchHtml(`HTTP://127.0.0.1:${port}/`, { blockList: allowLoopback() });
    server.close();
    expect(r).toEqual({ ok: true, html: "<p>hi</p>", finalUrl: `http://127.0.0.1:${port}/` });
  });

  it("rejects a redirect whose target uses a non-http(s) scheme", async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(302, { location: "javascript:alert(1)" }); res.end();
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: allowLoopback() });
    server.close();
    expect(r).toEqual({ ok: false, reason: "bad-scheme" });
  });

  it("blocks an IPv6 bracket-literal loopback URL with the default blocklist", async () => {
    // No server needed: the literal-IP pre-check must reject before ever connecting.
    const r = await safeFetchHtml("http://[::1]:1/");
    expect(r).toEqual({ ok: false, reason: "blocked-address" });
  });

  it("blocks an IPv4-mapped IPv6 bracket-literal URL with the default blocklist (post-URL-normalization form)", async () => {
    // WHATWG URL normalizes "[::ffff:127.0.0.1]" to the compressed hex form "[::ffff:7f00:1]"
    // before safeFetchHtml ever sees `hostname` — assert the full pipeline (not just the
    // isBlockedAddress unit, which is only exercised against the dotted-decimal form).
    const r = await safeFetchHtml("http://[::ffff:127.0.0.1]:1/");
    expect(r).toEqual({ ok: false, reason: "blocked-address" });
  });

  it("follows exactly 3 redirects (the default cap) and succeeds", async () => {
    const { server, port } = await listen((req, res) => {
      if (req.url === "/3") { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>done</p>"); return; }
      const n = Number(req.url!.slice(1) || "0");
      res.writeHead(302, { location: `/${n + 1}` }); res.end();
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/0`, { blockList: allowLoopback() });
    server.close();
    expect(r).toEqual({ ok: true, html: "<p>done</p>", finalUrl: `http://127.0.0.1:${port}/3` });
  });

  it("fails with too-many-redirects on a 4th redirect past the default cap", async () => {
    const { server, port } = await listen((req, res) => {
      const n = Number(req.url!.slice(1) || "0");
      res.writeHead(302, { location: `/${n + 1}` }); res.end();
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/0`, { blockList: allowLoopback() });
    server.close();
    expect(r).toEqual({ ok: false, reason: "too-many-redirects" });
  });

  it("enforces a total wall-clock deadline against a server that trickles bytes forever (idle timeout alone is insufficient)", async () => {
    const { server, port } = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.write("x"); /* never end */ });
    const start = Date.now();
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: new BlockList(), timeoutMs: 200 });
    server.close();
    expect(r).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("switches request implementations across a cross-protocol (http→https) redirect without crashing", async () => {
    // No TLS server available in this suite; the point is that the https branch is exercised
    // (protocol-switch doesn't throw) and still yields a typed result, not an unhandled rejection.
    const { server, port } = await listen((_req, res) => {
      res.writeHead(302, { location: `https://127.0.0.1:${port}/` }); res.end();
    });
    const r = await safeFetchHtml(`http://127.0.0.1:${port}/`, { blockList: allowLoopback(), timeoutMs: 1000 });
    server.close();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["unreachable", "timeout"]).toContain(r.reason);
  });
});
