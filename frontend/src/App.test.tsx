import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  Toaster: () => <div data-testid="toaster" />,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

vi.mock("@/pages/DashboardPage", () => ({
  default: () => <div data-testid="dashboard-page">Dashboard</div>,
}));
vi.mock("@/pages/ContainersPage", () => ({
  default: () => <div data-testid="containers-page">Containers</div>,
}));
vi.mock("@/pages/RulesPage", () => ({
  default: () => <div data-testid="rules-page">Rules</div>,
}));
vi.mock("@/pages/LogsPage", () => ({
  default: () => <div data-testid="logs-page">Logs</div>,
}));
vi.mock("@/pages/HistoryPage", () => ({
  default: () => <div data-testid="history-page">History</div>,
}));
vi.mock("@/pages/PoliciesPage", () => ({
  default: () => <div data-testid="policies-page">Policies</div>,
}));
vi.mock("@/pages/ProposalsPage", () => ({
  default: () => <div data-testid="proposals-page">Proposals</div>,
}));

vi.mock("@/lib/fleetApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fleetApi")>("@/lib/fleetApi");
  return {
    ...actual,
    whoami: vi.fn().mockResolvedValue({ username: "admin", auth_kind: "session" }),
    logout: vi.fn(),
    login: vi.fn(),
  };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    BrowserRouter: ({ children }: { children: React.ReactNode }) => (
      <actual.MemoryRouter initialEntries={[window.__APP_TEST_PATH__ ?? "/"]}>
        {children}
      </actual.MemoryRouter>
    ),
  };
});

declare global {
  interface Window {
    __APP_TEST_PATH__?: string;
  }
}

beforeEach(() => {
  window.__APP_TEST_PATH__ = "/";
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadApp() {
  const mod = await import("./App");
  return mod.default;
}

describe("App", () => {
  it("renders the dashboard route at /", async () => {
    window.__APP_TEST_PATH__ = "/";
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("dashboard-page")).toBeInTheDocument();
  });

  it("renders the containers page at /containers", async () => {
    window.__APP_TEST_PATH__ = "/containers";
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("containers-page")).toBeInTheDocument();
  });

  it("renders the rules page at /rules", async () => {
    window.__APP_TEST_PATH__ = "/rules";
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("rules-page")).toBeInTheDocument();
  });

  it("renders the logs page at /logs", async () => {
    window.__APP_TEST_PATH__ = "/logs";
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("logs-page")).toBeInTheDocument();
  });

  it("renders the history page at /history", async () => {
    window.__APP_TEST_PATH__ = "/history";
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("history-page")).toBeInTheDocument();
  });

  it("renders the policies page at /policies", async () => {
    window.__APP_TEST_PATH__ = "/policies";
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("policies-page")).toBeInTheDocument();
  });

  it("renders the proposals page at /proposals", async () => {
    window.__APP_TEST_PATH__ = "/proposals";
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByTestId("proposals-page")).toBeInTheDocument();
  });

  it("mounts the AppShell layout with Firefik brand", async () => {
    window.__APP_TEST_PATH__ = "/";
    const App = await loadApp();
    render(<App />);
    expect(await screen.findByText("Firefik")).toBeInTheDocument();
  });
});
