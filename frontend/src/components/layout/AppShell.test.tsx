import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/layout/AppShell";

let setTheme: ReturnType<typeof vi.fn>;
let resolvedTheme: "light" | "dark";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme, setTheme }),
}));

vi.mock("@/lib/panelMode", () => ({
  isPanelMode: true,
}));

vi.mock("@/lib/fleetApi", () => ({
  whoami: vi.fn().mockResolvedValue(null),
  logout: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  setTheme = vi.fn();
  resolvedTheme = "light";
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div data-testid="outlet-dashboard">Dash</div>} />
            <Route
              path="containers"
              element={<div data-testid="outlet-containers">Containers</div>}
            />
            <Route path="rules" element={<div data-testid="outlet-rules">Rules</div>} />
            <Route path="policies" element={<div data-testid="outlet-policies">Policies</div>} />
            <Route path="proposals" element={<div data-testid="outlet-proposals">Proposals</div>} />
            <Route path="logs" element={<div data-testid="outlet-logs">Logs</div>} />
            <Route path="history" element={<div data-testid="outlet-history">History</div>} />
            <Route path="login" element={<div data-testid="outlet-login">Login</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("renders the Firefik brand and all nav links", () => {
    renderAt("/");
    expect(screen.getByText("Firefik")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Containers" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rules" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Policies" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Proposals" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Logs" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "History" })).toBeInTheDocument();
  });

  it("renders the outlet content for the current route", () => {
    renderAt("/containers");
    expect(screen.getByTestId("outlet-containers")).toBeInTheDocument();
  });

  it("highlights the active route on the dashboard", () => {
    renderAt("/");
    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink.className).toMatch(/bg-primary/);
  });

  it("highlights the containers link when on /containers", () => {
    renderAt("/containers");
    const containersLink = screen.getByRole("link", { name: "Containers" });
    expect(containersLink.className).toMatch(/bg-primary/);
    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink.className).not.toMatch(/bg-primary/);
  });

  it("uses the main navigation landmark", () => {
    renderAt("/");
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  });

  it("shows the dark mode toggle when current theme is light", async () => {
    resolvedTheme = "light";
    renderAt("/");
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: /switch to dark mode/i });
    expect(toggle).toHaveTextContent("Dark mode");
    await user.click(toggle);
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("shows the light mode toggle when current theme is dark", async () => {
    resolvedTheme = "dark";
    renderAt("/");
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: /switch to light mode/i });
    expect(toggle).toHaveTextContent("Light mode");
    await user.click(toggle);
    expect(setTheme).toHaveBeenCalledWith("light");
  });

  it("renders panel-only nav items in panel mode", () => {
    renderAt("/");
    expect(screen.getByRole("link", { name: /Fleet/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Templates/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Approvals/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Agent tokens/i })).toBeInTheDocument();
  });

  it("renders the Sign out button when whoami returns session", async () => {
    const fleetApi = await import("@/lib/fleetApi");
    vi.mocked(fleetApi.whoami).mockResolvedValueOnce({
      username: "admin",
      auth_kind: "session",
    });
    renderAt("/");
    expect(await screen.findByRole("button", { name: /Sign out/i })).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("calls logout and navigates to /login on click", async () => {
    const fleetApi = await import("@/lib/fleetApi");
    vi.mocked(fleetApi.whoami).mockResolvedValueOnce({
      username: "admin",
      auth_kind: "session",
    });
    vi.mocked(fleetApi.logout).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderAt("/");
    const btn = await screen.findByRole("button", { name: /Sign out/i });
    await user.click(btn);
    await waitFor(() => {
      expect(fleetApi.logout).toHaveBeenCalled();
    });
    expect(await screen.findByTestId("outlet-login")).toBeInTheDocument();
  });

  it("surfaces a toast error when logout rejects and stays on page", async () => {
    const fleetApi = await import("@/lib/fleetApi");
    const sonner = await import("sonner");
    vi.mocked(fleetApi.whoami).mockResolvedValueOnce({
      username: "admin",
      auth_kind: "session",
    });
    vi.mocked(fleetApi.logout).mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    renderAt("/");
    const btn = await screen.findByRole("button", { name: /Sign out/i });
    await user.click(btn);
    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalledWith("network down");
    });
    expect(screen.queryByTestId("outlet-login")).not.toBeInTheDocument();
  });

  it("falls back to a generic toast message when logout throws non-Error", async () => {
    const fleetApi = await import("@/lib/fleetApi");
    const sonner = await import("sonner");
    vi.mocked(fleetApi.whoami).mockResolvedValueOnce({
      username: "admin",
      auth_kind: "session",
    });
    vi.mocked(fleetApi.logout).mockRejectedValueOnce("not-an-error");
    const user = userEvent.setup();
    renderAt("/");
    const btn = await screen.findByRole("button", { name: /Sign out/i });
    await user.click(btn);
    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalledWith("logout failed");
    });
  });

  it("falls back to 'Sign out' label when username is empty", async () => {
    const fleetApi = await import("@/lib/fleetApi");
    vi.mocked(fleetApi.whoami).mockResolvedValueOnce({
      username: "",
      auth_kind: "session",
    });
    renderAt("/");
    const btn = await screen.findByRole("button", { name: /Sign out/i });
    expect(btn).toHaveTextContent(/^Sign out$/);
  });

  it("hides the Sign out button when auth_kind is not session", async () => {
    const fleetApi = await import("@/lib/fleetApi");
    vi.mocked(fleetApi.whoami).mockResolvedValueOnce({
      username: "admin",
      auth_kind: "bearer",
    });
    renderAt("/");
    await waitFor(() => {
      expect(fleetApi.whoami).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button", { name: /Sign out/i })).not.toBeInTheDocument();
  });
});
