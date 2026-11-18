import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentLogsPanel } from "./AgentLogsPanel";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

afterEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.unstubAllGlobals();
});

describe("AgentLogsPanel", () => {
  it("opens a websocket against /api/agents/:id/logs and shows status", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<AgentLogsPanel agentID="host%a" />);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain("/api/agents/host%25a/logs");
    expect(screen.getByText("Connecting…")).toBeInTheDocument();

    act(() => ws.onopen?.());
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("appends parsed log lines and keeps the rolling buffer", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<AgentLogsPanel agentID="h1" />);
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.onopen?.());

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          agent: { instance_id: "h1", hostname: "h1" },
          at: "2026-04-23T10:00:00Z",
          level: "info",
          source: "rules",
          line: "applied",
        }),
      });
    });
    expect(screen.getByText("· 1 line")).toBeInTheDocument();

    act(() => ws.onmessage?.({ data: "{not-json" }));
    expect(screen.getByText("· 1 line")).toBeInTheDocument();
  });

  it("reconnects with backoff after an error and stops on unmount", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const { unmount } = render(<AgentLogsPanel agentID="h1" />);
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.onerror?.());
    expect(ws.closed).toBe(true);
    expect(screen.getByText(/reconnecting/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1]!;
    act(() => second.onopen?.());
    expect(screen.getByText("Live")).toBeInTheDocument();
    unmount();
    expect(second.closed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.useRealTimers();
  });

  it("does nothing when agentID is empty", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<AgentLogsPanel agentID="" />);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("AgentLogsPanel nflog rows", () => {
  it("renders dropped packets as structured rows", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<AgentLogsPanel agentID="h2" />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.onopen?.());
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          agent: { instance_id: "h2", hostname: "h2" },
          at: "2026-11-18T10:00:00Z",
          source: "nflog",
          line: "{}",
          fields: {
            action: "DROP",
            srcIP: "1.2.3.4",
            dstPort: "22",
            container: "host",
            rule: "host default",
          },
        }),
      });
      ws.onmessage?.({
        data: JSON.stringify({
          agent: { instance_id: "h2", hostname: "h2" },
          at: "2026-11-18T10:00:01Z",
          source: "nflog",
          line: "{}",
          fields: { event: "dropped", count: "3" },
        }),
      });
    });
    expect(screen.getByText("DROP")).toBeInTheDocument();
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
    expect(screen.getByText("· host · default policy")).toBeInTheDocument();
    expect(screen.getByText("· 1 line")).toBeInTheDocument();
  });
});

describe("AgentLogsPanel pause and clear", () => {
  function send(ws: FakeWebSocket, line: string) {
    ws.onmessage?.({
      data: JSON.stringify({
        agent: { instance_id: "h3", hostname: "h3" },
        at: "2026-11-18T10:00:00Z",
        source: "rules",
        line,
      }),
    });
  }

  it("freezes the list while paused and clears it on demand", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<AgentLogsPanel agentID="h3" />);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.onopen?.());
    act(() => send(ws, "first"));
    act(() => send(ws, "second"));
    expect(screen.getByText("· 2 lines")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("Paused")).toBeInTheDocument();
    act(() => send(ws, "third"));
    expect(screen.queryByText(/third/)).not.toBeInTheDocument();
    expect(screen.getByText("· 1 new line waiting")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByText(/third/)).toBeInTheDocument();
    expect(screen.getByText("· 3 lines")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/first/)).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for traffic/)).toBeInTheDocument();
  });
});
