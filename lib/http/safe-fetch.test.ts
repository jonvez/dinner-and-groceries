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
