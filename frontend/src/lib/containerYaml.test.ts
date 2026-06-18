import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containerToLabelsYaml, downloadTextFile } from "@/lib/containerYaml";
import type { ContainerDTO } from "@/types/api";

function baseContainer(overrides?: Partial<ContainerDTO>): ContainerDTO {
  return {
    id: "abcdef0123456789",
    name: "nginx",
    status: "running",
    enabled: true,
    firewallStatus: "active",
    labels: {},
    ...overrides,
  };
}

describe("containerToLabelsYaml", () => {
  it("emits minimal labels block for a bare container", () => {
    const yaml = containerToLabelsYaml(baseContainer());
    expect(yaml).toContain("# firefik config for nginx (abcdef012345)");
    expect(yaml).toContain("labels:");
    expect(yaml).toContain('firefik.enable: "true"');
    expect(yaml.endsWith("\n")).toBe(true);
  });

  it("emits enable=false when disabled", () => {
    const yaml = containerToLabelsYaml(baseContainer({ enabled: false }));
    expect(yaml).toContain('firefik.enable: "false"');
  });

  it("includes defaultPolicy line when present", () => {
    const yaml = containerToLabelsYaml(baseContainer({ defaultPolicy: "DROP" }));
    expect(yaml).toContain('firefik.defaultpolicy: "DROP"');
  });

  it("omits defaultPolicy line when missing", () => {
    const yaml = containerToLabelsYaml(baseContainer());
    expect(yaml).not.toContain("defaultpolicy");
  });

  it("skips rule sets prefixed with tpl: and pol:", () => {
    const yaml = containerToLabelsYaml(
      baseContainer({
        ruleSets: [
          { name: "tpl:web", ports: [80], allowlist: [], blocklist: [] },
          { name: "pol:strict", ports: [443], allowlist: [], blocklist: [] },
        ],
      }),
    );
    expect(yaml).not.toContain("tpl:web");
    expect(yaml).not.toContain("pol:strict");
  });

  it("renders ports, protocol, profile for a rule set", () => {
    const yaml = containerToLabelsYaml(
      baseContainer({
        ruleSets: [
          {
            name: "inbound",
            ports: [80, 443],
            allowlist: [],
            blocklist: [],
            protocol: "tcp",
            profile: "web",
          },
        ],
      }),
    );
    expect(yaml).toContain('firefik.firewall.inbound.ports: "80,443"');
    expect(yaml).toContain('firefik.firewall.inbound.protocol: "tcp"');
    expect(yaml).toContain('firefik.firewall.inbound.profile: "web"');
  });

  it("renders allowlist and blocklist when populated", () => {
    const yaml = containerToLabelsYaml(
      baseContainer({
        ruleSets: [
          {
            name: "ingress",
            ports: [],
            allowlist: ["10.0.0.0/24", "192.168.1.0/24"],
            blocklist: ["1.2.3.4"],
          },
        ],
      }),
    );
    expect(yaml).toContain('firefik.firewall.ingress.allowlist: "10.0.0.0/24,192.168.1.0/24"');
    expect(yaml).toContain('firefik.firewall.ingress.blocklist: "1.2.3.4"');
  });

  it("renders geoBlock and geoAllow when populated", () => {
    const yaml = containerToLabelsYaml(
      baseContainer({
        ruleSets: [
          {
            name: "geo",
            ports: [],
            allowlist: [],
            blocklist: [],
            geoBlock: ["CN", "RU"],
            geoAllow: ["US"],
          },
        ],
      }),
    );
    expect(yaml).toContain('firefik.firewall.geo.geoblock: "CN,RU"');
    expect(yaml).toContain('firefik.firewall.geo.geoallow: "US"');
  });

  it("renders rateLimit with rate and burst", () => {
    const yaml = containerToLabelsYaml(
      baseContainer({
        ruleSets: [
          {
            name: "rl",
            ports: [],
            allowlist: [],
            blocklist: [],
            rateLimit: { rate: 100, burst: 20 },
          },
        ],
      }),
    );
    expect(yaml).toContain('firefik.firewall.rl.ratelimit: "100/s,burst=20"');
  });

  it("renders log and logPrefix when present", () => {
    const yaml = containerToLabelsYaml(
      baseContainer({
        ruleSets: [
          {
            name: "lg",
            ports: [],
            allowlist: [],
            blocklist: [],
            log: true,
            logPrefix: "FFK:",
          },
        ],
      }),
    );
    expect(yaml).toContain('firefik.firewall.lg.log: "true"');
    expect(yaml).toContain('firefik.firewall.lg.logPrefix: "FFK:"');
  });

  it("omits optional rule-set fields when not provided", () => {
    const yaml = containerToLabelsYaml(
      baseContainer({
        ruleSets: [{ name: "minimal", ports: [], allowlist: [], blocklist: [] }],
      }),
    );
    expect(yaml).not.toContain("minimal.ports");
    expect(yaml).not.toContain("minimal.protocol");
    expect(yaml).not.toContain("minimal.profile");
    expect(yaml).not.toContain("minimal.allowlist");
    expect(yaml).not.toContain("minimal.blocklist");
    expect(yaml).not.toContain("minimal.geoblock");
    expect(yaml).not.toContain("minimal.geoallow");
    expect(yaml).not.toContain("minimal.ratelimit");
    expect(yaml).not.toContain("minimal.log");
  });

  it("handles missing ruleSets field entirely", () => {
    const yaml = containerToLabelsYaml(baseContainer({ ruleSets: undefined }));
    expect(yaml).toContain('firefik.enable: "true"');
    expect(yaml).not.toContain("firefik.firewall.");
  });
});

describe("downloadTextFile", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let anchorClick: ReturnType<typeof vi.fn>;
  let origCreate: typeof document.createElement;

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:fake");
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    anchorClick = vi.fn();
    origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag) as HTMLElement;
      if (tag === "a") {
        (el as HTMLAnchorElement).click = anchorClick as unknown as () => void;
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a blob URL, triggers anchor click, and revokes the URL", () => {
    downloadTextFile("hello", "out.yaml");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blobArg = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe("text/yaml");
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("sets filename on the anchor", () => {
    const anchors: HTMLAnchorElement[] = [];
    vi.mocked(document.createElement).mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") {
        (el as HTMLAnchorElement).click = anchorClick as unknown as () => void;
        anchors.push(el as HTMLAnchorElement);
      }
      return el;
    });
    downloadTextFile("body", "my-file.yaml");
    expect(anchors[0]?.download).toBe("my-file.yaml");
    expect(anchors[0]?.href).toContain("blob:fake");
  });
});
