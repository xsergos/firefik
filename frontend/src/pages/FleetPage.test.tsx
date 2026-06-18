import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FleetPage from "./FleetPage";

vi.mock("@/lib/fleetApi", () => ({
  fetchAgents: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FleetPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ISO_NOW = new Date().toISOString();
const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();

beforeEach(async () => {
  const api = await import("@/lib/fleetApi");
  vi.mocked(api.fetchAgents).mockResolvedValue([
    {
      instance_id: "host-a",
      hostname: "host-a",
      version: "0.2.0",
      backend: "nft",
      chain: "FF",
      first_seen: ISO_NOW,
      last_seen: ISO_NOW,
      event_count: 1,
      has_snapshot: true,
      status: "healthy",
    },
    {
      instance_id: "host-b",
      hostname: "host-b",
      version: "0.2.0",
      backend: "iptables",
      chain: "FF",
      first_seen: twoDaysAgo,
      last_seen: tenMinAgo,
      event_count: 0,
      has_snapshot: false,
      status: "stale",
    },
    {
      instance_id: "host-c",
      hostname: "host-c",
      version: "0.2.0",
      backend: "",
      chain: "FF",
      first_seen: twoDaysAgo,
      last_seen: twoHoursAgo,
      event_count: 0,
      has_snapshot: false,
      status: "dead",
    },
    {
      instance_id: "host-d",
      hostname: "host-d",
      version: "0.2.0",
      backend: "nft",
      chain: "FF",
      first_seen: twoDaysAgo,
      last_seen: twoDaysAgo,
      event_count: 0,
      has_snapshot: false,
      status: "unknown",
    },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("FleetPage", () => {
  it("renders the agent list with status badges", async () => {
    renderPage();
    expect(await screen.findByText("Fleet")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("host-a").length).toBeGreaterThan(0));
    expect(screen.getAllByText("host-b").length).toBeGreaterThan(0);
    expect(screen.getAllByText("host-c").length).toBeGreaterThan(0);
    expect(screen.getAllByText("host-d").length).toBeGreaterThan(0);
    expect(screen.getAllByText("nft").length).toBeGreaterThan(0);
    expect(screen.getByText("iptables")).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getByText("dead")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("renders the empty-state when there are no agents", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgents).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No agents registered yet/i)).toBeInTheDocument());
  });

  it("renders an error state when the API rejects", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgents).mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Could not connect/i));
  });
});
