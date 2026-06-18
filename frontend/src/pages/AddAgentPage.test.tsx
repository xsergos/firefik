import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AddAgentPage from "./AddAgentPage";

vi.mock("@/lib/fleetApi", () => ({
  createEnrollmentToken: vi.fn(),
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
  const api = await import("@/lib/fleetApi");
  vi.mocked(api.createEnrollmentToken).mockResolvedValue({
    token: "abcdef0123456789",
    agent_id: "host-01",
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    issued_at: new Date().toISOString(),
  });
});

afterEach(() => vi.clearAllMocks());

describe("AddAgentPage", () => {
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
});
