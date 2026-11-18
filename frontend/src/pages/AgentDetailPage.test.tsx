import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentDetailPage from "./AgentDetailPage";

vi.mock("@/lib/fleetApi", () => ({
  fetchAgentSnapshot: vi.fn(),
  fetchAgentStats: vi.fn(),
  fetchAgentTokens: vi.fn(),
  fetchFlows: vi.fn(),
  sendAgentCommand: vi.fn(),
  deleteAgent: vi.fn(),
}));

vi.mock("./AgentLogsPanel", () => ({
  AgentLogsPanel: ({ agentID }: { agentID: string }) => (
    <div data-testid="agent-logs">{agentID}</div>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function renderAt(path = "/fleet/host-a") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/fleet/:id" element={<AgentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SNAP = {
  agent: {
    instance_id: "host-a",
    hostname: "host-a",
    version: "0.2.0",
    backend: "nft",
    chain: "FF",
    first_seen: "2026-04-23T10:00:00Z",
    last_seen: "2026-04-23T10:00:00Z",
    event_count: 1,
    has_snapshot: true,
    status: "healthy" as const,
  },
  snapshot: {
    agent: {
      instance_id: "host-a",
      hostname: "host-a",
      version: "0.2.0",
      backend: "nft",
      chain: "FF",
    },
    containers: [
      {
        id: "c1234567890abcdef",
        name: "web",
        status: "running",
        firewall_status: "active",
        default_policy: "DROP",
        rule_set_count: 2,
        sources: ["docker"],
      },
      {
        id: "d1234567890abcdef",
        name: "db",
        status: "exited",
        firewall_status: "inactive",
        default_policy: "RETURN",
        rule_set_count: 0,
      },
    ],
    at: "2026-04-23T10:00:00Z",
  },
};

beforeEach(async () => {
  const api = await import("@/lib/fleetApi");
  vi.mocked(api.fetchAgentSnapshot).mockResolvedValue(SNAP);
  vi.mocked(api.fetchAgentStats).mockResolvedValue({
    containers: { total: 2, running: 1, enabled: 1 },
    traffic: [],
    rules_active_containers: 1,
    at: "2026-04-23T10:00:00Z",
  });
  vi.mocked(api.sendAgentCommand).mockResolvedValue({
    id: "cmd1",
    agent_id: "host-a",
    action: "apply",
  });
  vi.mocked(api.fetchAgentTokens).mockResolvedValue([
    {
      id: "t1",
      name: "host-a",
      description: "",
      issued_by: "admin",
      issued_at: "2026-04-23T10:00:00Z",
      last_used_ip: "",
    },
  ]);
  vi.mocked(api.fetchFlows).mockResolvedValue({
    rows: [],
    summary: { total: 5123, unique_sources: 3, top_port: 22, top_port_count: 5000 },
    hourly: [],
  });
  vi.mocked(api.deleteAgent).mockResolvedValue();
});

afterEach(() => vi.clearAllMocks());

describe("AgentDetailPage", () => {
  it("renders agent metadata and container rows", async () => {
    renderAt();
    expect(await screen.findByRole("heading", { name: "host-a" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    expect(screen.getByText("db")).toBeInTheDocument();
    expect(screen.getByText("docker")).toBeInTheDocument();
    expect(screen.getByTestId("agent-logs")).toHaveTextContent("host-a");
  });

  it("dispatches reconcile when the button is clicked", async () => {
    const api = await import("@/lib/fleetApi");
    renderAt();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reconcile" }));
    await waitFor(() =>
      expect(api.sendAgentCommand).toHaveBeenCalledWith("host-a", "reconcile", undefined),
    );
  });

  it("dispatches per-container apply", async () => {
    const api = await import("@/lib/fleetApi");
    renderAt();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Re-apply rules for web" }));
    await waitFor(() =>
      expect(api.sendAgentCommand).toHaveBeenCalledWith("host-a", "apply", "c1234567890abcdef"),
    );
    await user.click(screen.getByRole("button", { name: "Apply rules for db" }));
    await waitFor(() =>
      expect(api.sendAgentCommand).toHaveBeenCalledWith("host-a", "apply", "d1234567890abcdef"),
    );
  });

  it("asks before disabling a container firewall", async () => {
    const api = await import("@/lib/fleetApi");
    renderAt();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Turn off firewall for web" }));
    expect(api.sendAgentCommand).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(api.sendAgentCommand).toHaveBeenCalledWith("host-a", "disable", "c1234567890abcdef"),
    );
  });

  it("shows summary tiles and shortcuts filtered to this agent", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText(/^5\D?123$/)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Containers of this agent/ })).toHaveAttribute(
      "href",
      "/containers?agent=host-a",
    );
    expect(screen.getByText("Agent token").nextSibling).toHaveTextContent("active");
  });

  it("offers Remove only for offline agents", async () => {
    const api = await import("@/lib/fleetApi");
    renderAt();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();

    vi.mocked(api.fetchAgentSnapshot).mockResolvedValue({
      ...SNAP,
      agent: { ...SNAP.agent, status: "dead" },
    });
    const user = userEvent.setup();
    const { unmount } = renderAt();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await user.click(await screen.findByRole("button", { name: "Remove agent" }));
    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith("host-a"));
    unmount();
  });

  it("renders empty containers note when snapshot has none", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentSnapshot).mockResolvedValue({
      agent: SNAP.agent,
      snapshot: null,
    });
    renderAt();
    await waitFor(() => expect(screen.getByText(/No snapshot yet/i)).toBeInTheDocument());
  });

  it("renders an error state when fetch fails", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentSnapshot).mockRejectedValue(new Error("boom"));
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Could not load agent/i),
    );
  });

  it("falls back to snapshot counts when the stats pull fails", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentStats).mockRejectedValue(new Error("timeout"));
    renderAt();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    expect(screen.getAllByText("Containers")[0]!.nextSibling).toHaveTextContent("2");
  });
});

describe("AgentDetailPage vocabulary and links", () => {
  it("links tiles and container names to filtered pages", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute(
      "href",
      "/containers?agent=host-a&name=web&exact=1",
    );
    expect(screen.getByText("Firewall active").closest("a")).toHaveAttribute(
      "href",
      "/containers?agent=host-a&firewall=active",
    );
    expect(screen.getByText("Drops, 24 h").closest("a")).toHaveAttribute(
      "href",
      "/logs?agent=host-a&action=DROP",
    );
    expect(screen.getByText("Agent token").closest("a")).toHaveAttribute("href", "/agent-tokens");
    expect(
      screen.getByText(/Container counts come from the agent's last report/),
    ).toBeInTheDocument();
  });

  it("counts tiles from the snapshot even when live stats disagree", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentStats).mockResolvedValue({
      containers: { total: 9, running: 9, enabled: 9 },
      traffic: [],
      rules_active_containers: 9,
      at: "2026-04-23T10:00:00Z",
    });
    renderAt();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    expect(screen.getByText("Firewall active").nextSibling).toHaveTextContent("1");
  });

  it("uses the shared firewall labels and disables Apply for unlabelled Off containers", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentSnapshot).mockResolvedValue({
      ...SNAP,
      snapshot: {
        ...SNAP.snapshot,
        containers: [
          ...SNAP.snapshot.containers,
          {
            id: "e1234567890abcdef",
            name: "plain",
            status: "running",
            firewall_status: "disabled",
            default_policy: "",
            rule_set_count: 0,
          },
          {
            id: "f1234567890abcdef",
            name: "labelled",
            status: "running",
            firewall_status: "disabled",
            default_policy: "",
            labels: { "firefik.enable": "true" },
            rule_set_count: 0,
          },
        ],
      },
    });
    renderAt();
    await waitFor(() => expect(screen.getByText("plain")).toBeInTheDocument());
    expect(screen.getAllByText("Off")).toHaveLength(2);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add firefik labels/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply rules for db" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Apply rules for labelled" })).toBeEnabled();
  });

  it("says the command was sent and marks the row as applying", async () => {
    const { toast } = await import("sonner");
    renderAt();
    await waitFor(() => expect(screen.getByText("db")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Apply rules for db" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Sent to host-a: applying rules to db…"),
    );
    expect(screen.getByText("applying…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply rules for db" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Re-apply rules for web" })).toBeEnabled();
  });

  it("lists containers by name", async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    const names = screen
      .getAllByRole("link")
      .map((a) => a.textContent)
      .filter((t) => t === "web" || t === "db");
    expect(names).toEqual(["db", "web"]);
  });
});
