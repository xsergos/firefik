import { describe, expect, it } from "vitest";
import {
  containerSchema,
  firewallRuleSetSchema,
  logStreamMessageSchema,
  policySimulateResponseSchema,
  ruleEntrySchema,
  statsResponseSchema,
} from "@/types/api";

describe("containerSchema", () => {
  it("accepts a minimal valid payload", () => {
    const res = containerSchema.safeParse({
      id: "abcdef012345",
      name: "nginx",
      status: "running",
      enabled: true,
      firewallStatus: "active",
    });
    expect(res.success).toBe(true);
  });

  it("rejects unknown firewallStatus", () => {
    const res = containerSchema.safeParse({
      id: "a",
      name: "n",
      status: "running",
      enabled: true,
      firewallStatus: "made-up",
    });
    expect(res.success).toBe(false);
  });
});

describe("logStreamMessageSchema", () => {
  it("accepts a regular log entry", () => {
    const res = logStreamMessageSchema.safeParse({
      ts: "2026-04-23T12:00:00Z",
      action: "DROP",
      srcIP: "1.2.3.4",
    });
    expect(res.success).toBe(true);
  });

  it("recognises the dropped control message", () => {
    const res = logStreamMessageSchema.safeParse({ event: "dropped", count: 5 });
    expect(res.success).toBe(true);
  });

  it("recognises server_shutdown", () => {
    const res = logStreamMessageSchema.safeParse({ event: "server_shutdown" });
    expect(res.success).toBe(true);
  });
});

describe("ruleEntrySchema", () => {
  it("requires defaultPolicy to be in enum", () => {
    const res = ruleEntrySchema.safeParse({
      containerID: "abc",
      containerName: "n",
      status: "running",
      defaultPolicy: "INVALID",
      ruleSets: [],
    });
    expect(res.success).toBe(false);
  });
});

describe("statsResponseSchema", () => {
  it("parses the backend stats shape", () => {
    const res = statsResponseSchema.safeParse({
      containers: { total: 1, running: 1, enabled: 1 },
      traffic: [{ ts: "t", accepted: 0, dropped: 0 }],
    });
    expect(res.success).toBe(true);
  });
});

describe("firewallRuleSetSchema", () => {
  it("turns null and missing lists into empty arrays", () => {
    const res = firewallRuleSetSchema.parse({
      name: "rs",
      ports: null,
      allowlist: null,
      geoBlock: null,
    });
    expect(res.ports).toEqual([]);
    expect(res.allowlist).toEqual([]);
    expect(res.blocklist).toEqual([]);
    expect(res.geoBlock).toBeUndefined();
  });

  it("still rejects out-of-range ports", () => {
    expect(firewallRuleSetSchema.safeParse({ name: "rs", ports: [70000] }).success).toBe(false);
  });
});

describe("policySimulateResponseSchema", () => {
  it("accepts a geo-only rule set with null ports from the control plane", () => {
    const res = policySimulateResponseSchema.safeParse({
      policy: "web-public",
      ruleSets: [{ name: "web-public-1", ports: null, allowlist: null, blocklist: null }],
      warnings: null,
    });
    expect(res.success).toBe(true);
    expect(res.data?.ruleSets[0]?.ports).toEqual([]);
    expect(res.data?.warnings).toBeUndefined();
  });
});
