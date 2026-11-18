import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AddAgentPage from "./AddAgentPage";

vi.mock("@/lib/fleetApi", () => ({
  createEnrollmentToken: vi.fn(),
  fetchPanelConfig: vi.fn().mockResolvedValue({ enroll_url: "", grpc_endpoint: "" }),
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
        <AddAgentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  const api = await import("@/lib/fleetApi");
  vi.mocked(api.fetchPanelConfig).mockResolvedValue({ enroll_url: "", grpc_endpoint: "" });
  vi.mocked(api.createEnrollmentToken).mockResolvedValue({
    token: "abcdef0123456789",
    agent_id: "host-01",
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    issued_at: new Date().toISOString(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AddAgentPage", () => {
  it("prefills endpoints from the control-plane config", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchPanelConfig).mockResolvedValue({
      enroll_url: "https://fw-01.example",
      grpc_endpoint: "fw-01.example:8444",
    });
    renderPage();
    expect(await screen.findByDisplayValue("https://fw-01.example")).toBeInTheDocument();
    expect(screen.getByDisplayValue("fw-01.example:8444")).toBeInTheDocument();
  });

  it("remembers the endpoints used for the last token", async () => {
    window.localStorage.setItem(
      "firefik.addAgent.endpoints",
      JSON.stringify({ http: "https://saved.example", grpc: "saved.example:8444" }),
    );
    renderPage();
    expect(screen.getByDisplayValue("https://saved.example")).toBeInTheDocument();
    expect(screen.getByDisplayValue("saved.example:8444")).toBeInTheDocument();
  });

  it("renders the form with default values", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Add agent" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("host-01")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://cp.example.com:8443")).toBeInTheDocument();
    expect(screen.getByDisplayValue("cp.example.com:8444")).toBeInTheDocument();
  });

  it("disables the generate button when the instance ID is invalid", async () => {
    renderPage();
    const user = userEvent.setup();
    const idInput = screen.getByDisplayValue("host-01");
    await user.clear(idInput);
    await user.type(idInput, "X");
    expect(screen.getByText(/Must match \[a-z0-9-]/)).toBeInTheDocument();
    const generateBtn = screen.getByRole("button", { name: "Generate token" });
    expect(generateBtn).toBeDisabled();
  });

  it("disables generate when the HTTP URL is invalid", async () => {
    renderPage();
    const user = userEvent.setup();
    const httpInput = screen.getByDisplayValue("https://cp.example.com:8443");
    await user.clear(httpInput);
    await user.type(httpInput, "not a url");
    expect(screen.getByText(/Must be https:/)).toBeInTheDocument();
  });

  it("disables generate when the gRPC endpoint is invalid", async () => {
    renderPage();
    const user = userEvent.setup();
    const grpcInput = screen.getByDisplayValue("cp.example.com:8444");
    await user.clear(grpcInput);
    await user.type(grpcInput, "no-port");
    expect(screen.getByText(/Must be host:port/)).toBeInTheDocument();
  });

  it("creates a token and shows the bash + compose snippets", async () => {
    const api = await import("@/lib/fleetApi");
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    await waitFor(() => expect(api.createEnrollmentToken).toHaveBeenCalled());
    expect(await screen.findByText(/Step 1 — Run on the new host/)).toBeInTheDocument();
    expect(screen.getByText(/Step 2 — Boot the agent container/)).toBeInTheDocument();
    expect(screen.getByText(/• expires in/)).toBeInTheDocument();
  });

  it("regenerates the token after a second click", async () => {
    const api = await import("@/lib/fleetApi");
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    await screen.findByText(/Step 1 — Run on the new host/);
    await user.click(screen.getByRole("button", { name: "Generate new token" }));
    await waitFor(() => expect(api.createEnrollmentToken).toHaveBeenCalledTimes(2));
  });

  it("labels every field so it has an accessible name", () => {
    renderPage();
    expect(screen.getByLabelText("Instance ID")).toHaveValue("host-01");
    expect(screen.getByLabelText(/Code expires after/)).toHaveValue(15);
    expect(screen.getByLabelText("Enrollment address")).toHaveValue("https://cp.example.com:8443");
    expect(screen.getByLabelText("Agent connection address")).toHaveValue("cp.example.com:8444");
  });

  it("lists prerequisites and links to Agent tokens for hosts that cannot enroll", () => {
    renderPage();
    expect(screen.getByText("jq")).toBeInTheDocument();
    expect(screen.getByText("curl")).toBeInTheDocument();
    expect(screen.getByText(/root shell/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agent tokens" })).toHaveAttribute(
      "href",
      "/agent-tokens",
    );
  });

  it("keeps the raw TTL while typing and validates it on blur", async () => {
    const api = await import("@/lib/fleetApi");
    renderPage();
    const user = userEvent.setup();
    const ttl = screen.getByLabelText(/Code expires after/);
    await user.clear(ttl);
    expect(ttl).toHaveValue(null);
    await user.tab();
    expect(screen.getByText(/Enter a whole number of minutes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate token" })).toBeDisabled();

    await user.type(ttl, "30");
    await user.tab();
    expect(ttl).toHaveValue(30);
    expect(screen.queryByText(/Enter a whole number of minutes/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    await waitFor(() => expect(api.createEnrollmentToken).toHaveBeenCalledWith("host-01", 30 * 60));
  });

  it("warns when an endpoint points at localhost", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchPanelConfig).mockResolvedValue({
      enroll_url: "https://localhost:8443",
      grpc_endpoint: "127.0.0.1:8444",
    });
    renderPage();
    await screen.findByDisplayValue("https://localhost:8443");
    expect(screen.getAllByText(/A remote host cannot reach localhost/)).toHaveLength(2);
  });

  it("counts the expiry down while the page stays open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = await import("@/lib/fleetApi");
    const issuedAt = Date.now();
    vi.mocked(api.createEnrollmentToken).mockResolvedValue({
      token: "abcdef0123456789",
      agent_id: "host-01",
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + 2 * 60_000).toISOString(),
    });
    renderPage();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByText(/expires in 2 min/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(await screen.findByText(/expires in 1 min/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(await screen.findByText(/• expired/)).toBeInTheDocument();
  });
});
