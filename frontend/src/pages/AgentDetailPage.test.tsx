import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentDetailPage from "./AgentDetailPage";

vi.mock("@/lib/fleetApi", () => ({
  fetchAgentSnapshot: vi.fn(),
  fetchAgentStats: vi.fn(),
  sendAgentCommand: vi.fn(),
}));

vi.mock("./AgentLogsPanel", () => ({
  AgentLogsPanel: ({ agentID }: { agentID: string }) => (
    <div data-testid="agent-logs">{agentID}</div>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
    const applyBtns = screen.getAllByRole("button", { name: "Apply" });
    await user.click(applyBtns[0]!);
    await waitFor(() =>
      expect(api.sendAgentCommand).toHaveBeenCalledWith("host-a", "apply", "c1234567890abcdef"),
    );
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

  it("renders live-stats fallback when stats pull rejects", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentStats).mockRejectedValue(new Error("timeout"));
    renderAt();
    await waitFor(() => expect(screen.getByText(/Stats pull timed out/i)).toBeInTheDocument());
  });
});
