import { describe, expect, it } from "vitest";
import { formatActor } from "./actor";

describe("formatActor", () => {
  it("names token fingerprints in plain words", () => {
    expect(formatActor("fp:2ae20acbf2b447d1@172.18.0.1")).toEqual({
      label: "Operator token (172.18.0.1)",
      title: "fp:2ae20acbf2b447d1@172.18.0.1",
    });
    expect(formatActor("anonymous@10.0.0.1").label).toBe("Operator token (10.0.0.1)");
  });

  it("keeps user names and adds the address", () => {
    expect(formatActor("admin@198.51.100.7").label).toBe("admin (198.51.100.7)");
    expect(formatActor("admin").label).toBe("admin");
  });

  it("handles empty values", () => {
    expect(formatActor(undefined).label).toBe("—");
    expect(formatActor("").label).toBe("—");
  });
});
