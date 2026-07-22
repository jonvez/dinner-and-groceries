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
