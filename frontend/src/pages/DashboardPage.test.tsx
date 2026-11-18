import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StatsResponse } from "@/types/api";
import DashboardPage from "./DashboardPage";

vi.mock("recharts", () => {
  const SvgStub = ({ children }: { children?: React.ReactNode }) => (
    <svg data-testid="rechart-stub">{children}</svg>
  );
  const XAxis = ({ tickFormatter }: { tickFormatter?: (v: string) => string }) => (
    <div data-testid="xaxis-stub">
      {tickFormatter ? tickFormatter("2026-04-23T10:00:00Z") : null}
    </div>
  );
  const Tooltip = ({
    labelFormatter,
    formatter,
  }: {
    labelFormatter?: (v: unknown) => string;
    formatter?: (value: unknown, name: unknown) => unknown;
  }) => (
    <div data-testid="tooltip-stub">
      <span>{labelFormatter ? labelFormatter("2026-04-23T10:00:00Z") : ""}</span>
      <span>{labelFormatter ? labelFormatter("") : ""}</span>
      <span>{labelFormatter ? labelFormatter(42) : ""}</span>
      <span>{formatter ? JSON.stringify(formatter(100, "accepted")) : ""}</span>
      <span>{formatter ? JSON.stringify(formatter(50, "dropped")) : ""}</span>
    </div>
  );
  const Legend = ({ formatter }: { formatter?: (v: unknown) => string }) => (
    <div data-testid="legend-stub">
      <span>{formatter ? formatter("accepted") : ""}</span>
      <span>{formatter ? formatter("dropped") : ""}</span>
    </div>
  );
  const YAxis = ({ label }: { label?: { value?: string } }) => (
    <div data-testid="yaxis-stub">{label?.value}</div>
  );
  const Area = ({ type, dataKey }: { type?: string; dataKey?: string }) => (
    <span data-testid={`area-${dataKey}`} data-type={type} />
  );
  return {
    AreaChart: SvgStub,
    Area,
    XAxis,
    YAxis,
    Tooltip,
    Legend,
    ResponsiveContainer: SvgStub,
  };
});

vi.mock("@/lib/api", () => ({
  fetchStats: vi.fn(),
  fetchContainers: vi.fn(),
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

vi.mock("@/lib/fleetApi", () => ({
  fetchFleetStats: vi.fn(),
  fetchFlows: vi.fn(),
}));

const noFlows = {
  rows: [],
  summary: { total: 0, unique_sources: 0, top_port: 0, top_port_count: 0 },
  hourly: [],
};

let panelMode = false;
vi.mock("@/lib/panelMode", () => ({
  get isPanelMode() {
    return panelMode;
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
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function buildStats(overrides?: Partial<StatsResponse>): StatsResponse {
  return {
    containers: { total: 5, running: 3, enabled: 2 },
    traffic: [
      { ts: "2026-04-23T10:00:00Z", accepted: 100, dropped: 5 },
      { ts: "2026-04-23T10:01:00Z", accepted: 120, dropped: 8 },
    ],
    ...overrides,
  };
}

beforeEach(async () => {
  panelMode = false;
  const api = await import("@/lib/api");
  vi.mocked(api.fetchStats).mockResolvedValue(buildStats());
  vi.mocked(api.fetchContainers).mockResolvedValue([]);
  const fleet = await import("@/lib/fleetApi");
  vi.mocked(fleet.fetchFlows).mockResolvedValue(noFlows);
  vi.mocked(fleet.fetchFleetStats).mockResolvedValue({
    agents: { total: 4, healthy: 3, stale: 1, dead: 0, unknown: 0 },
    containers: { total: 9, running: 7, enabled: 5 },
    traffic: [
      { ts: "2026-04-23T10:00:00Z", accepted: 200, dropped: 8 },
      { ts: "2026-04-23T10:01:00Z", accepted: 220, dropped: 10 },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DashboardPage", () => {
  it("renders the heading and stat cards once data resolves", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Total containers")).toBeInTheDocument());
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders the traffic chart container when traffic data is present", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Traffic (last 60 min)")).toBeInTheDocument());
    expect(await screen.findAllByTestId("rechart-stub")).not.toHaveLength(0);
  });

  it("draws straight lines and labels the y-axis with the bucket size", async () => {
    renderPage();
    expect(await screen.findByTestId("yaxis-stub")).toHaveTextContent("packets/min");
    expect(screen.getByTestId("area-accepted")).toHaveAttribute("data-type", "linear");
    expect(screen.getByTestId("area-dropped")).toHaveAttribute("data-type", "linear");
  });

  it("links the stat tiles to the matching pages", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Total containers")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Total containers/ })).toHaveAttribute(
      "href",
      "/containers",
    );
    expect(screen.getByRole("link", { name: /Firewall active/ })).toHaveAttribute(
      "href",
      "/containers?firewall=active",
    );
  });

  it("renders the empty-state message when traffic is missing", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchStats).mockResolvedValue(buildStats({ traffic: [] }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/No traffic data yet/i)).toBeInTheDocument());
  });

  it("downsamples a long traffic series without crashing", async () => {
    const long: StatsResponse["traffic"] = [];
    for (let i = 0; i < 700; i++) {
      long.push({
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        accepted: i,
        dropped: i % 3,
      });
    }
    const api = await import("@/lib/api");
    vi.mocked(api.fetchStats).mockResolvedValue(buildStats({ traffic: long }));
    renderPage();
    await waitFor(() => expect(screen.getByText("Total containers")).toBeInTheDocument());
    const stubs = await screen.findAllByTestId("rechart-stub");
    expect(stubs.length).toBeGreaterThan(0);
    expect(screen.getByTestId("yaxis-stub")).toHaveTextContent("packets per 3 min");
  });

  it("shows an error state when fetchStats rejects", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchStats).mockRejectedValue(new Error("nope"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Failed to load dashboard stats/i),
    );
  });
});

describe("FleetDashboard (panel mode)", () => {
  it("renders the fleet stats and traffic chart", async () => {
    panelMode = true;
    renderPage();
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Agents (total)")).toBeInTheDocument());
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Containers (total)")).toBeInTheDocument();
    expect(screen.getByText(/Fleet traffic/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Stale/ })).toHaveAttribute(
      "href",
      "/fleet?status=stale",
    );
    expect(screen.getByRole("link", { name: /Dead/ })).toHaveAttribute(
      "href",
      "/fleet?status=dead",
    );
  });

  it("lists what needs attention with links", async () => {
    panelMode = true;
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([
      {
        id: "a1",
        name: "web",
        status: "running",
        enabled: true,
        firewallStatus: "inactive",
        labels: {},
      },
      {
        id: "a2",
        name: "db",
        status: "running",
        enabled: true,
        firewallStatus: "active",
        labels: {},
      },
    ]);
    const fleet = await import("@/lib/fleetApi");
    vi.mocked(fleet.fetchFleetStats).mockResolvedValue({
      agents: { total: 4, healthy: 1, stale: 1, dead: 2, unknown: 0 },
      containers: { total: 2, running: 2, enabled: 1 },
      traffic: [],
    });
    vi.mocked(fleet.fetchFlows).mockResolvedValue({
      ...noFlows,
      summary: { ...noFlows.summary, total: 4211 },
    });
    renderPage();
    const strip = await screen.findByRole("region", { name: "Needs attention" });
    await waitFor(() => expect(strip.querySelectorAll("li")).toHaveLength(4));
    expect(screen.getByRole("link", { name: "2 agents stopped reporting" })).toHaveAttribute(
      "href",
      "/fleet?status=dead",
    );
    expect(screen.getByRole("link", { name: "1 agent reporting late" })).toHaveAttribute(
      "href",
      "/fleet?status=stale",
    );
    expect(
      screen.getByRole("link", { name: "1 container waiting for firewall rules to be applied" }),
    ).toHaveAttribute("href", "/containers?firewall=inactive");
    expect(screen.getByRole("link", { name: /packets dropped in the last hour/ })).toHaveAttribute(
      "href",
      "/logs",
    );
    expect(fleet.fetchFlows).toHaveBeenCalledWith({ since: "1h", action: "DROP" });
  });

  it("hides the attention strip when all is clear", async () => {
    panelMode = true;
    const fleet = await import("@/lib/fleetApi");
    vi.mocked(fleet.fetchFleetStats).mockResolvedValue({
      agents: { total: 2, healthy: 2, stale: 0, dead: 0, unknown: 0 },
      containers: { total: 0, running: 0, enabled: 0 },
      traffic: [],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Agents (total)")).toBeInTheDocument());
    await waitFor(() => expect(fleet.fetchFlows).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();
  });

  it("renders the fleet empty-state when traffic is missing", async () => {
    panelMode = true;
    const fleet = await import("@/lib/fleetApi");
    vi.mocked(fleet.fetchFleetStats).mockResolvedValue({
      agents: { total: 0, healthy: 0, stale: 0, dead: 0, unknown: 0 },
      containers: { total: 0, running: 0, enabled: 0 },
      traffic: [],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No traffic from any agent yet/i)).toBeInTheDocument(),
    );
  });

  it("renders the fleet error state when fetchFleetStats rejects", async () => {
    panelMode = true;
    const fleet = await import("@/lib/fleetApi");
    vi.mocked(fleet.fetchFleetStats).mockRejectedValue(new Error("nope"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Failed to load fleet stats/i),
    );
  });
});
