import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentTokensPage from "./AgentTokensPage";

vi.mock("@/lib/fleetApi", () => ({
  fetchAgentTokens: vi.fn(),
  fetchAgents: vi.fn(),
  createAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AgentTokensPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  const api = await import("@/lib/fleetApi");
  vi.mocked(api.fetchAgentTokens).mockResolvedValue([
    {
      id: "id-1",
      name: "prod-1",
      description: "primary",
      issued_by: "operator-x",
      issued_at: "2026-04-23T10:00:00Z",
      last_used_at: "2026-04-23T11:00:00Z",
      last_used_ip: "10.0.0.5",
      revoked_at: null,
    },
  ]);
  vi.mocked(api.createAgentToken).mockResolvedValue({
    id: "id-2",
    name: "new-host",
    description: "",
    issued_by: "operator-x",
    issued_at: "2026-04-23T12:00:00Z",
    last_used_at: null,
    last_used_ip: "",
    revoked_at: null,
    token: "agt_aabbccddeeffaabbccddeeffaabbccddeeffaabbccddeeffaabbccddeeffaa11",
  });
  vi.mocked(api.revokeAgentToken).mockResolvedValue();
  vi.mocked(api.fetchAgents).mockResolvedValue([
    {
      instance_id: "prod-1",
      hostname: "prod-1",
      version: "v1",
      backend: "nftables",
      chain: "FIREFIK",
      first_seen: "2026-04-23T10:00:00Z",
      last_seen: "2026-04-23T11:00:00Z",
      event_count: 0,
      has_snapshot: true,
      status: "dead",
    },
  ]);
});

afterEach(() => vi.clearAllMocks());

describe("AgentTokensPage", () => {
  it("renders the list with active badge and last-seen info", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Agent tokens" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("prod-1")).toBeInTheDocument());
    expect(screen.getByText("primary")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText(/10\.0\.0\.5/)).toBeInTheDocument();
  });

  it("labels the token time as the last connection and explains it", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("prod-1")).toBeInTheDocument());
    expect(screen.queryByText("Last seen")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Last connected" })).toHaveAttribute(
      "title",
      expect.stringMatching(/Regular check-ins do not change it/),
    );
    expect(screen.getByText(/10\.0\.0\.5/)).toHaveAttribute(
      "title",
      expect.stringMatching(/answers a command from the panel/),
    );
  });

  it("points most hosts at Add agent and links the agent column to its page", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Agent tokens" });
    expect(screen.getByRole("heading", { name: "Tokens" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add agent/ })).toHaveAttribute("href", "/fleet/add");
    expect(await screen.findByRole("link", { name: "Open agent prod-1" })).toHaveAttribute(
      "href",
      "/fleet/prod-1",
    );
  });

  it("shows relative times with the absolute time on hover and a readable issuer", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentTokens).mockResolvedValue([
      {
        id: "id-9",
        name: "edge-9",
        description: "",
        issued_by: "fp:abcdef@10.1.1.1",
        issued_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        last_used_at: null,
        last_used_ip: "",
        revoked_at: null,
      },
    ]);
    renderPage();
    const issued = await screen.findByText("2h ago");
    expect(issued.getAttribute("title")).toBeTruthy();
    expect(screen.getByText("Operator token (10.1.1.1)")).toHaveAttribute(
      "title",
      "fp:abcdef@10.1.1.1",
    );
  });

  it("disables Issue when name is blank", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Agent tokens" });
    const btn = screen.getByRole("button", { name: "Issue token" });
    expect(btn).toBeDisabled();
  });

  it("issues a token and surfaces the plaintext banner", async () => {
    const api = await import("@/lib/fleetApi");
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Agent tokens" });
    await user.type(screen.getByPlaceholderText("prod-host-01"), "new-host");
    await user.click(screen.getByRole("button", { name: "Issue token" }));
    await waitFor(() => expect(api.createAgentToken).toHaveBeenCalledWith("new-host", undefined));
    expect(await screen.findByText(/Copy this token now/i)).toBeInTheDocument();
    expect(screen.getByText(/agt_aabbccddeeff/)).toBeInTheDocument();
  });

  it("shows the status of the agent that owns the token", async () => {
    renderPage();
    expect(await screen.findByText("dead")).toBeInTheDocument();
  });

  it("revokes a token after confirmation", async () => {
    const api = await import("@/lib/fleetApi");
    renderPage();
    await screen.findByRole("heading", { name: "Agent tokens" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await user.click(await screen.findByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(api.revokeAgentToken).toHaveBeenCalledWith("id-1"));
  });

  it("skips revoke when the operator cancels the confirm dialog", async () => {
    const api = await import("@/lib/fleetApi");
    renderPage();
    await screen.findByRole("heading", { name: "Agent tokens" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(api.revokeAgentToken).not.toHaveBeenCalled();
  });

  it("renders empty state when no tokens exist", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentTokens).mockResolvedValue([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No agent tokens issued yet/i)).toBeInTheDocument(),
    );
  });

  it("renders error state when API rejects", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchAgentTokens).mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Could not load agent tokens/i),
    );
  });

  it("re-fetches with include_revoked when checkbox toggles", async () => {
    const api = await import("@/lib/fleetApi");
    renderPage();
    await screen.findByText("prod-1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(api.fetchAgentTokens).toHaveBeenLastCalledWith(true));
  });
});
