import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuleEntry } from "@/types/api";
import RulesPage from "./RulesPage";

vi.mock("@/lib/api", () => ({
  fetchRules: vi.fn(),
  APIError: class APIError extends Error {
    readonly status: number;
    readonly code: string;
    readonly userMessage: string;
    constructor(status: number, code: string, userMessage: string) {
      super(userMessage);
      this.status = status;
      this.code = code;
      this.userMessage = userMessage;
    }
  },
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RulesPage />
    </QueryClientProvider>,
  );
}

const baseEntry: RuleEntry = {
  containerID: "abcdef012345",
  containerName: "nginx",
  status: "running",
  defaultPolicy: "DROP",
  ruleSets: [
    {
      name: "web",
      ports: [80, 443],
      allowlist: ["10.0.0.0/24"],
      blocklist: [],
      protocol: "tcp",
      profile: "edge",
      log: true,
      rateLimit: { rate: 100, burst: 50 },
    },
  ],
};

const hostEntry: RuleEntry = {
  containerID: "(host)",
  containerName: "host",
  status: "host",
  defaultPolicy: "ACCEPT",
  ruleSets: [
    {
      name: "ssh",
      ports: [22],
      allowlist: ["192.168.1.0/24"],
      blocklist: [],
      protocol: "tcp",
    },
  ],
};

beforeEach(async () => {
  const api = await import("@/lib/api");
  vi.mocked(api.fetchRules).mockResolvedValue([baseEntry]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("RulesPage", () => {
  it("renders the heading and the container card after fetch resolves", async () => {
    renderPage();
    expect(await screen.findByText("Active Rules")).toBeInTheDocument();
    expect(await screen.findByText("nginx")).toBeInTheDocument();
    expect(screen.getByText("abcdef012345")).toBeInTheDocument();
    expect(screen.getByText("DROP")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("renders rule-set ports, protocol, profile, allowlist, and rate-limit badges", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    expect(screen.getByText("80, 443")).toBeInTheDocument();
    expect(screen.getByText("TCP")).toBeInTheDocument();
    expect(screen.getByText("edge")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.0/24")).toBeInTheDocument();
    expect(screen.getByText("log")).toBeInTheDocument();
    expect(screen.getByText("100/s")).toBeInTheDocument();
  });

  it("collapses long allowlists into a +N more badge", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      {
        ...baseEntry,
        ruleSets: [
          {
            name: "web",
            ports: [],
            allowlist: ["1.0.0.0/24", "2.0.0.0/24", "3.0.0.0/24", "4.0.0.0/24", "5.0.0.0/24"],
            blocklist: [],
          },
        ],
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("+3 more")).toBeInTheDocument());
    expect(screen.getByText("any")).toBeInTheDocument();
  });

  it("renders geo allow/block badges when present", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      {
        ...baseEntry,
        ruleSets: [
          {
            name: "geo",
            ports: [22],
            allowlist: [],
            blocklist: ["6.6.6.6"],
            geoBlock: ["RU", "CN"],
            geoAllow: ["US"],
          },
        ],
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("block:RU,CN")).toBeInTheDocument());
    expect(screen.getByText("allow:US")).toBeInTheDocument();
    expect(screen.getByText("6.6.6.6")).toBeInTheDocument();
  });

  it("falls back to a 'No rule sets' message when ruleSets is empty", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([{ ...baseEntry, ruleSets: [] }]);
    renderPage();
    await waitFor(() => expect(screen.getByText("No rule sets.")).toBeInTheDocument());
  });

  it("shows an empty-state hint when the response is an empty array", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No active firewall rules/i)).toBeInTheDocument());
  });

  it("renders the error state when fetchRules rejects", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Failed to load rules/i),
    );
  });

  it("groups entries by agent and renders host + container sections", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      { ...hostEntry, agent_hostname: "alpha", agent_id: "agent-1" },
      { ...baseEntry, agent_hostname: "alpha", agent_id: "agent-1" },
      {
        ...baseEntry,
        containerID: "ffeeddccbbaa",
        containerName: "redis",
        agent_hostname: "beta",
        agent_id: "agent-2",
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getAllByText("Host firewall").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Containers").length).toBeGreaterThan(0);
    expect(screen.getByText("agent-1")).toBeInTheDocument();
    expect(screen.getByText("agent-2")).toBeInTheDocument();
    expect(screen.getByText("1 host · 1 container")).toBeInTheDocument();
    expect(screen.getByText("0 host · 1 container")).toBeInTheDocument();
  });

  it("renders 'local agent' label when agent info missing", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([baseEntry]);
    renderPage();
    await waitFor(() => expect(screen.getByText("local agent")).toBeInTheDocument());
  });

  it("filters entries by free-text and shows empty-filter hint when none match", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([baseEntry]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Search rules"), "zzz-nope");
    expect(await screen.findByText(/No rules match the current filters/i)).toBeInTheDocument();
    expect(screen.queryByText("nginx")).not.toBeInTheDocument();
  });

  it("filters rule sets by port and drops entries whose sets do not match", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      {
        ...baseEntry,
        ruleSets: [
          { name: "web", ports: [80], allowlist: [], blocklist: [], protocol: "tcp" },
          { name: "ssh", ports: [22], allowlist: [], blocklist: [], protocol: "tcp" },
        ],
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Filter by port"), "22");
    await waitFor(() => expect(screen.getByText("ssh")).toBeInTheDocument());
    expect(screen.queryByText("web")).not.toBeInTheDocument();
  });

  it("ignores out-of-range port filter values", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([baseEntry]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Filter by port"), "99999");
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("filters by address substring (case-insensitive)", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      {
        ...baseEntry,
        ruleSets: [
          { name: "web", ports: [80], allowlist: ["10.0.0.0/24"], blocklist: [], protocol: "tcp" },
          {
            name: "db",
            ports: [5432],
            allowlist: ["172.16.0.0/16"],
            blocklist: [],
            protocol: "tcp",
          },
        ],
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Filter by address"), "172.16");
    await waitFor(() => expect(screen.getByText("db")).toBeInTheDocument());
    expect(screen.queryByText("web")).not.toBeInTheDocument();
  });

  it("shows the clear button when filters are active and resets state on click", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    expect(screen.queryByLabelText("Clear filters")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Search rules"), "nginx");
    const clearBtn = await screen.findByLabelText("Clear filters");

    await user.click(clearBtn);
    expect(screen.queryByLabelText("Clear filters")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search rules")).toHaveValue("");
  });

  it("renders blocklist entries with destructive styling", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      {
        ...baseEntry,
        ruleSets: [
          {
            name: "deny",
            ports: [80],
            allowlist: [],
            blocklist: ["7.7.7.7", "8.8.8.8"],
            protocol: "tcp",
          },
        ],
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("7.7.7.7")).toBeInTheDocument());
    expect(screen.getByText("8.8.8.8")).toBeInTheDocument();
  });

  it("renders host section with 'No host rules.' when no filter applied", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([{ ...baseEntry, agent_hostname: "alpha" }]);
    renderPage();
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());
    expect(screen.getByText("No host rules.")).toBeInTheDocument();
  });

  it("renders 'No host rules match.' when port filter drops the host entry but a container survives", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      { ...hostEntry, agent_hostname: "alpha" },
      { ...baseEntry, agent_hostname: "alpha" },
    ]);
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Filter by port"), "80");
    expect(await screen.findByText("No host rules match.")).toBeInTheDocument();
    expect(screen.queryByText("ssh")).not.toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("does not show the agent-id badge when agent label equals agent id", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      { ...baseEntry, agent_id: "agent-1", agent_hostname: "" as unknown as string },
    ]);
    renderPage();
    const titleEl = await screen.findByText("agent-1");
    const cardTitle = titleEl.closest('[class*="flex"]');
    if (cardTitle) {
      const badges = within(cardTitle as HTMLElement).queryAllByText("agent-1");
      expect(badges.length).toBe(1);
    }
  });

  it("renders fallback dash when allowlist/blocklist are empty", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchRules).mockResolvedValue([
      {
        ...baseEntry,
        ruleSets: [{ name: "noop", ports: [80], allowlist: [], blocklist: [], protocol: "tcp" }],
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("noop")).toBeInTheDocument());
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});
