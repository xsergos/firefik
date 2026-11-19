import { describe, expect, it } from "vitest";

import { isPrivateIP, isValidSourceFilter, parseCidr, parseIP, sourceMatches } from "./ip";

describe("parseIP", () => {
  it("parses IPv4, IPv6 and v4-mapped IPv6", () => {
    expect(parseIP("10.0.0.1")).toEqual({ bits: 32, value: 0x0a000001n });
    expect(parseIP("::1")).toEqual({ bits: 128, value: 1n });
    expect(parseIP("2001:db8::")?.value).toBe(0x20010db8n << 96n);
    expect(parseIP("::ffff:172.20.0.1")).toEqual({ bits: 32, value: 0xac140001n });
  });

  it("rejects malformed addresses", () => {
    for (const bad of [
      "",
      "1.2.3",
      "1.2.3.256",
      "a.b.c.d",
      "1::2::3",
      "12345::",
      "1:2:3:4:5:6:7:8:9",
    ]) {
      expect(parseIP(bad)).toBeNull();
    }
  });
});

describe("parseCidr", () => {
  it("accepts valid prefixes and rejects bad ones", () => {
    expect(parseCidr("172.16.0.0/12")?.prefix).toBe(12);
    expect(parseCidr("2001:db8::/32")?.prefix).toBe(32);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("10.0.0.0/")).toBeNull();
    expect(parseCidr("10.0.0/8")).toBeNull();
  });
});

describe("isPrivateIP", () => {
  it.each([
    ["10.1.2.3", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["100.64.0.1", true],
    ["127.0.0.1", true],
    ["fd12::1", true],
    ["fe80::1", true],
    ["31.41.158.252", false],
    ["2a00:1450::1", false],
    ["garbage", false],
  ])("%s → %s", (ip, want) => {
    expect(isPrivateIP(ip)).toBe(want);
  });
});

describe("sourceMatches", () => {
  it("matches by prefix, CIDR and scope", () => {
    expect(sourceMatches("172.18.0.2", "172.", "")).toBe(true);
    expect(sourceMatches("172.18.0.2", "172.16.0.0/12", "")).toBe(true);
    expect(sourceMatches("172.32.0.2", "172.16.0.0/12", "")).toBe(false);
    expect(sourceMatches("185.220.101.7", "185.220.101.0/24", "public")).toBe(true);
    expect(sourceMatches("10.0.0.5", "", "private")).toBe(true);
    expect(sourceMatches("10.0.0.5", "", "public")).toBe(false);
    expect(sourceMatches("", "", "public")).toBe(false);
    expect(sourceMatches("10.0.0.5", "10.0.0.0/99", "")).toBe(false);
  });

  it("flags only malformed CIDRs as invalid", () => {
    expect(isValidSourceFilter("172.")).toBe(true);
    expect(isValidSourceFilter("172.16.0.0/12")).toBe(true);
    expect(isValidSourceFilter("172.16.0.0/")).toBe(false);
  });
});
