import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLogStream } from "./useLogStream";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
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

function mostRecentWS(): FakeWebSocket {
  const last = FakeWebSocket.instances.at(-1);
  if (!last) throw new Error("no fake websocket created yet");
  return last;
}

describe("useLogStream", () => {
  it("appends parsed log entries in reverse-chronological order", () => {
    const { result } = renderHook(() => useLogStream());
    const ws = mostRecentWS();

    act(() => {
      ws.onopen?.();
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ ts: "2026-04-23T10:00:00Z", action: "DROP", srcIP: "1.1.1.1" }),
        }),
      );
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ ts: "2026-04-23T10:00:01Z", action: "ACCEPT", srcIP: "2.2.2.2" }),
        }),
      );
    });

    expect(result.current.logs).toHaveLength(2);
    expect(result.current.logs[0]?.action).toBe("ACCEPT");
    expect(result.current.logs[1]?.action).toBe("DROP");
    expect(result.current.connected).toBe(true);
  });

  it("emits a toast when the backend signals backpressure drops", () => {
    renderHook(() => useLogStream());
    const ws = mostRecentWS();

    act(() => {
      ws.onopen?.();
      ws.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify({ event: "dropped", count: 7 }) }),
      );
    });

    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("7"), expect.anything());
  });

  it("emits an info toast on server_shutdown", () => {
    renderHook(() => useLogStream());
    const ws = mostRecentWS();

    act(() => {
      ws.onopen?.();
      ws.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify({ event: "server_shutdown" }) }),
      );
    });

    expect(toast.info).toHaveBeenCalled();
  });

  it("silently drops malformed frames without touching state", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useLogStream());
    const ws = mostRecentWS();

    act(() => {
      ws.onopen?.();
      ws.onmessage?.(new MessageEvent("message", { data: "not json{" }));
      ws.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ bogus: true }) }));
    });

    expect(result.current.logs).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reconnects after close with growing backoff", () => {
    renderHook(() => useLogStream());
    const first = mostRecentWS();

    act(() => {
      first.onopen?.();
      first.onclose?.();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = mostRecentWS();
    act(() => {
      second.onopen?.();
      second.onclose?.();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("closes the socket on unmount and bumps session so stale frames are ignored", () => {
    const { result, unmount } = renderHook(() => useLogStream());
    const ws = mostRecentWS();
    act(() => ws.onopen?.());

    unmount();
    expect(ws.closed).toBe(true);

    act(() => {
      ws.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ ts: "t", action: "DROP", srcIP: "x" }),
        }),
      );
    });
    expect(result.current.logs).toHaveLength(0);
  });

  it("sets error state and toasts when the socket errors out", () => {
    const { result } = renderHook(() => useLogStream());
    const ws = mostRecentWS();

    act(() => {
      ws.onerror?.();
    });

    expect(result.current.error).toMatch(/disconnect/i);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/disconnect/i),
      expect.objectContaining({ id: "logstream-error", duration: Infinity }),
    );
    expect(ws.closed).toBe(true);
  });

  it("ignores onerror callbacks fired after unmount (stale session)", () => {
    const { result, unmount } = renderHook(() => useLogStream());
    const ws = mostRecentWS();
    unmount();

    act(() => {
      ws.onerror?.();
    });

    expect(result.current.error).toBeNull();
  });

  it("dismisses any error toast and resets attempt counter on successful reopen", () => {
    renderHook(() => useLogStream());
    const first = mostRecentWS();

    act(() => {
      first.onerror?.();
      first.onclose?.();
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    const second = mostRecentWS();
    act(() => {
      second.onopen?.();
    });

    expect(toast.dismiss).toHaveBeenCalledWith("logstream-error");
  });

  it("rebuilds the websocket when the filter argument changes", () => {
    const { rerender } = renderHook(({ f }: { f?: string }) => useLogStream(f), {
      initialProps: { f: "foo" },
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    rerender({ f: "bar" });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0]?.closed).toBe(true);
  });

  it("ignores onopen callbacks fired after unmount (stale session)", () => {
    const { result, unmount } = renderHook(() => useLogStream());
    const ws = mostRecentWS();
    unmount();

    act(() => {
      ws.onopen?.();
    });

    expect(result.current.connected).toBe(false);
  });

  it("ignores onclose callbacks fired after unmount (stale session)", () => {
    const { result, unmount } = renderHook(() => useLogStream());
    const ws = mostRecentWS();
    act(() => {
      ws.onopen?.();
    });
    expect(result.current.connected).toBe(true);
    unmount();

    act(() => {
      ws.onclose?.();
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
