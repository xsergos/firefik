import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import FleetPage from "./FleetPage";

vi.mock("@/lib/fleetApi", () => ({
  fetchAgents: vi.fn(),
  fetchAgentTokens: vi.fn(),
  deleteAgent: vi.fn(),
  revokeAgentToken: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchContainers: vi.fn(),
}));

function renderPage(path = "/fleet") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
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
  const lib = await import("@/lib/api");
  vi.mocked(lib.fetchContainers).mockResolvedValue([
    {
      id: "c1",
      name: "web",
      status: "running",
      enabled: true,
      firewallStatus: "active",
      labels: {},
      agent_id: "host-a",
    },
    {
      id: "c2",
      name: "db",
      status: "running",
      enabled: false,
      firewallStatus: "disabled",
      labels: {},
      agent_id: "host-a",
    },
  ]);
  const api = await import("@/lib/fleetApi");
  vi.mocked(api.fetchAgentTokens).mockResolvedValue([]);
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
    const table = within(screen.getByRole("table"));
    expect(table.getByText("healthy")).toBeInTheDocument();
    expect(table.getByText("stale")).toBeInTheDocument();
    expect(table.getByText("dead")).toBeInTheDocument();
    expect(table.getByText("unknown")).toBeInTheDocument();
  });

  it("filters by status chip and search", async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findAllByText("host-a");
    await user.click(screen.getByRole("button", { name: /^dead/ }));
    expect(screen.queryByRole("link", { name: "host-a" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "host-c" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^all/ }));
    await user.type(screen.getByLabelText("Search agents"), "host-b");
    expect(screen.getByRole("link", { name: "host-b" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "host-c" })).not.toBeInTheDocument();
  });

  it("warns about agents offline for more than a day", async () => {
    renderPage();
    const banner = await screen.findByText(/offline for more than 24 h/);
    expect(banner).toHaveTextContent(/host-d/);
    expect(banner).not.toHaveTextContent(/host-c/);
  });

  it("offers Remove only for non-healthy agents and revokes the token when asked", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentTokens).mockResolvedValue([
      {
        id: "tok-c",
        name: "host-c",
        description: "",
        issued_by: "admin",
        issued_at: ISO_NOW,
        last_used_ip: "",
      },
    ]);
    vi.mocked(api.deleteAgent).mockResolvedValue();
    vi.mocked(api.revokeAgentToken).mockResolvedValue();
    renderPage();
    const user = userEvent.setup();
    await screen.findAllByText("host-a");
    expect(
      screen.getAllByRole("button", { name: "Remove" }).filter((b) => !b.hasAttribute("disabled")),
    ).toHaveLength(3);
    const row = screen.getByRole("link", { name: "host-c" }).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/Also revoke its agent token/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove agent" }));
    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith("host-c"));
    await waitFor(() => expect(api.revokeAgentToken).toHaveBeenCalledWith("tok-c"));
  });

  it("does not revoke the token when the box is unchecked", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentTokens).mockResolvedValue([
      {
        id: "tok-c",
        name: "host-c",
        description: "",
        issued_by: "admin",
        issued_at: ISO_NOW,
        last_used_ip: "",
      },
    ]);
    vi.mocked(api.deleteAgent).mockResolvedValue();
    renderPage();
    const user = userEvent.setup();
    await screen.findAllByText("host-a");
    const row = screen.getByRole("link", { name: "host-c" }).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await user.click(await screen.findByLabelText(/Also revoke its agent token/));
    await user.click(screen.getByRole("button", { name: "Remove agent" }));
    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith("host-c"));
    expect(api.revokeAgentToken).not.toHaveBeenCalled();
  });

  it("renders the empty-state when there are no agents", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgents).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No agents registered yet/i)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Add agent" })).toHaveAttribute("href", "/fleet/add");
    expect(screen.queryByText(/firefik-admin/)).not.toBeInTheDocument();
  });

  it("shows a disabled Remove with a hint for online agents instead of the word online", async () => {
    renderPage();
    const row = (await screen.findByRole("link", { name: "host-a" })).closest("tr")!;
    const btn = within(row).getByRole("button", { name: "Remove" });
    expect(btn).toBeDisabled();
    expect(btn.parentElement).toHaveAttribute("title", "Stop the agent first");
    expect(within(row).queryByText("online")).not.toBeInTheDocument();
  });

  it("shows container and protected counts per agent", async () => {
    renderPage();
    const row = (await screen.findByRole("link", { name: "host-a" })).closest("tr")!;
    await waitFor(() => expect(within(row).getByText("2")).toBeInTheDocument());
    expect(within(row).getByText("1")).toBeInTheDocument();
    const other = screen.getByRole("link", { name: "host-b" }).closest("tr")!;
    expect(within(other).getAllByText("0")).toHaveLength(2);
  });

  it("reads the status filter from the URL", async () => {
    renderPage("/fleet?status=stale");
    expect(await screen.findByRole("link", { name: "host-b" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "host-a" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^stale/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores an unknown status in the URL", async () => {
    renderPage("/fleet?status=bogus");
    expect(await screen.findByRole("link", { name: "host-a" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "host-c" })).toBeInTheDocument();
  });

  it("renders an error state when the API rejects", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgents).mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Could not connect/i));
  });
});
