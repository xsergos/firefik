import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LogsPage from "./LogsPage";
import { ruleLabel } from "@/lib/flows";

let panelMode = false;
vi.mock("@/lib/panelMode", () => ({
  get isPanelMode() {
    return panelMode;
  },
}));

vi.mock("@/lib/fleetApi", () => ({
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchFlows: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  },
}));

type Listener = (ev: MessageEvent<string>) => void;
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: Listener | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

let originalWebSocket: typeof WebSocket;

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: originalWebSocket,
  });
  vi.clearAllMocks();
});

function renderAgent(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function mostRecentWS(): FakeWebSocket {
  const last = FakeWebSocket.instances.at(-1);
  if (!last) throw new Error("no fake websocket created yet");
  return last;
}

describe("LogsPage", () => {
  it("says it is connecting before the socket opens", () => {
    renderAgent(<LogsPage />);
    expect(screen.getByRole("heading", { name: "Traffic log" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
    expect(screen.getByText(/Waiting for firewall events/i)).toBeInTheDocument();
  });

  it("uses the same status words as the agent page", () => {
    renderAgent(<LogsPage />);
    const ws = mostRecentWS();
    act(() => ws.onopen?.());
    expect(screen.getByRole("status")).toHaveTextContent(/^Live$/);
    act(() => ws.onclose?.());
    expect(screen.getByRole("status")).toHaveTextContent("Disconnected, reconnecting…");
  });

  it("pauses, resumes and clears the live list", () => {
    renderAgent(<LogsPage />);
    const ws = mostRecentWS();
    const send = (srcIP: string) =>
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ ts: "2026-04-23T10:00:00Z", action: "DROP", srcIP }),
        }),
      );
    act(() => {
      ws.onopen?.();
      send("9.9.9.9");
    });
    expect(screen.getByText("1 line", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("status")).toHaveTextContent("Paused");
    act(() => send("8.8.8.8"));
    expect(screen.queryByText("8.8.8.8")).not.toBeInTheDocument();
    expect(screen.getByText(/1 new line waiting/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByText("8.8.8.8")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/^Live$/);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("9.9.9.9")).not.toBeInTheDocument();
    expect(screen.queryByText("8.8.8.8")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    act(() => send("7.7.7.7"));
    expect(screen.getByText("7.7.7.7")).toBeInTheDocument();
  });

  it("renders an incoming log entry with action, srcIP, port, container, and proto", () => {
    renderAgent(<LogsPage />);
    const ws = mostRecentWS();
    act(() => {
      ws.onopen?.();
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            ts: "2026-04-23T10:00:00Z",
            action: "DROP",
            srcIP: "1.2.3.4",
            dstPort: 443,
            container: "nginx",
            proto: "tcp",
          }),
        }),
      );
    });
    expect(screen.getByText("DROP")).toBeInTheDocument();
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
    expect(screen.getByText(":443")).toBeInTheDocument();
    expect(screen.getByText("nginx")).toBeInTheDocument();
    expect(screen.getByText("tcp")).toBeInTheDocument();
    const line = screen.getByText("1.2.3.4").parentElement;
    expect(line?.textContent).toContain("1.2.3.4→nginx:443tcp");
    expect(screen.queryByRole("button", { name: "1.2.3.4" })).not.toBeInTheDocument();
  });

  it("displays both ACCEPT and DROP rows in reverse-chronological order", () => {
    renderAgent(<LogsPage />);
    const ws = mostRecentWS();
    act(() => {
      ws.onopen?.();
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ ts: "2026-04-23T10:00:00Z", action: "DROP", srcIP: "9.9.9.9" }),
        }),
      );
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ ts: "2026-04-23T10:00:01Z", action: "ACCEPT", srcIP: "8.8.8.8" }),
        }),
      );
    });
    expect(screen.getByText("ACCEPT")).toBeInTheDocument();
    expect(screen.getByText("DROP")).toBeInTheDocument();
    expect(screen.getByText("9.9.9.9")).toBeInTheDocument();
    expect(screen.getByText("8.8.8.8")).toBeInTheDocument();
  });
});

describe("ruleLabel", () => {
  it("names default-policy and host rules for humans", () => {
    expect(ruleLabel("default")).toBe("default policy");
    expect(ruleLabel("host default")).toBe("host · default policy");
    expect(ruleLabel("host ssh")).toBe("host · ssh");
    expect(ruleLabel("web-public@v4")).toBe("web-public@v4");
    expect(ruleLabel(undefined)).toBe("rule");
  });
});

describe("LogsPage in panel mode", () => {
  beforeEach(() => {
    panelMode = true;
    vi.useRealTimers();
  });
  afterEach(() => {
    panelMode = false;
  });

  function LocationProbe() {
    const location = useLocation();
    return <output data-testid="location">{location.search}</output>;
  }

  function renderPanel(path = "/logs") {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <LogsPage />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  const emptyFlows = {
    rows: [],
    summary: { total: 0, unique_sources: 0, top_port: 0, top_port_count: 0 },
    hourly: [],
  };

  function oneRow() {
    return {
      rows: [
        {
          agent_id: "app-01",
          action: "DROP",
          container: "host",
          src_ip: "185.220.101.7",
          dst_port: 22,
          proto: "TCP",
          rule: "host default",
          count: 4211,
          first_seen: "2026-11-18T08:00:00Z",
          last_seen: new Date().toISOString(),
        },
      ],
      summary: { total: 4211, unique_sources: 1, top_port: 22, top_port_count: 4211 },
      hourly: [
        { at: new Date(Date.now() - 3_600_000).toISOString(), count: 400 },
        { at: new Date().toISOString(), count: 21 },
      ],
    };
  }

  it("shows the 24 h drop summary and aggregated rows", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchFlows).mockResolvedValue(oneRow());
    renderPanel();
    expect(screen.getByRole("heading", { name: "Traffic log" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("185.220.101.7")).toBeInTheDocument());
    expect(screen.getByText("Dropped, 24 h")).toBeInTheDocument();
    expect(screen.getByText("host · default policy")).toBeInTheDocument();
    expect(screen.getByText("min 0 · max 400")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Events per hour over the last 24 hours/ }),
    ).toBeInTheDocument();
    expect(api.fetchFlows).toHaveBeenCalledWith(
      expect.objectContaining({ since: "24h", action: "DROP" }),
    );
    expect(screen.getByRole("link", { name: "How the traffic log works" })).toHaveAttribute(
      "href",
      "/help/traffic",
    );
  });

  it("reads the view and filters from the URL", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchFlows).mockResolvedValue(emptyFlows);
    renderPanel("/logs?view=7d&agent=app-01&container=web&action=ACCEPT");
    await waitFor(() =>
      expect(api.fetchFlows).toHaveBeenCalledWith(
        expect.objectContaining({
          since: "7d",
          agent_id: "app-01",
          container: "web",
          action: "ACCEPT",
        }),
      ),
    );
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Accepted" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Container")).toHaveValue("web");
    expect(screen.getByLabelText("Agent")).toHaveValue("app-01");
  });

  it("explains why accepted traffic may be missing", async () => {
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchFlows).mockResolvedValue(emptyFlows);
    renderPanel("/logs?action=ACCEPT");
    expect(
      await screen.findByText("No accepted traffic logged in this period"),
    ).toBeInTheDocument();
    expect(screen.getByText(/logged only for rules that have/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /How this works/ })).toHaveAttribute(
      "href",
      "/help/traffic",
    );
  });

  it("writes filter changes to the URL and applies a clicked value as a filter", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchFlows).mockResolvedValue(oneRow());
    renderPanel();
    await screen.findByText("185.220.101.7");
    await user.click(screen.getByRole("button", { name: "185.220.101.7" }));
    expect(screen.getByTestId("location")).toHaveTextContent("src=185.220.101.7");
    expect(screen.getByLabelText("Source")).toHaveValue("185.220.101.7");
    await waitFor(() =>
      expect(api.fetchFlows).toHaveBeenCalledWith(
        expect.objectContaining({ src: "185.220.101.7" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: ":22" }));
    expect(screen.getByTestId("location")).toHaveTextContent("port=22");
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByTestId("location")).toHaveTextContent("action=all");
    await user.click(screen.getByRole("button", { name: "Last 24 h" }));
    await user.click(screen.getByRole("button", { name: "7 days" }));
    expect(screen.getByTestId("location")).toHaveTextContent("view=7d");
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\?view=7d$/);
  });

  it("renders control-plane live lines in the Live view in source → container order", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/fleetApi");
    vi.mocked(api.fetchFlows).mockResolvedValue(emptyFlows);
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Live" }));
    expect(screen.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "true");
    const ws = mostRecentWS();
    act(() => {
      ws.onopen?.();
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            agent: { instance_id: "app-02" },
            at: "2026-11-18T10:00:00Z",
            source: "nflog",
            line: JSON.stringify({
              ts: "2026-11-18T10:00:00Z",
              action: "DROP",
              srcIP: "45.155.205.233",
              dstPort: 8080,
              proto: "TCP",
              container: "web",
              rule: "default",
            }),
          }),
        }),
      );
    });
    expect(screen.getByText("45.155.205.233")).toBeInTheDocument();
    expect(screen.getByText("app-02")).toBeInTheDocument();
    expect(screen.getByText("· default policy")).toBeInTheDocument();
    const line = screen.getByText("45.155.205.233").parentElement;
    expect(line?.textContent).toContain("45.155.205.233→web:8080tcp· default policy");
    await user.click(screen.getByRole("button", { name: "web" }));
    expect(screen.getByTestId("location")).toHaveTextContent("container=web");
    expect(screen.getByLabelText("Container")).toHaveValue("web");
  });
});
