import { describe, it, expect } from "vitest";
import { isBlockedAddress, makeGuardedLookup, buildReservedBlockList } from "./safe-fetch";

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
