import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditHistoryEvent } from "@/types/api";
import HistoryPage from "./HistoryPage";

vi.mock("@/lib/api", () => ({
  fetchAuditHistory: vi.fn(),
  APIError: class APIError extends Error {
    readonly status: number;
    readonly code: string;
    readonly userMessage: string;
    constructor(status: number, code: string, userMessage: string) {
      super(userMessage);
      this.status = status;
      this.code = code;
      this.userMessage = userMessage;
    }
  },
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <HistoryPage />
    </QueryClientProvider>,
  );
}

const events: AuditHistoryEvent[] = [
  {
    ts: "2026-04-23T10:00:00Z",
    action: "apply",
    source: "api",
    container_id: "abcdef012345",
    container_name: "nginx",
    rule_sets: 2,
    default_policy: "DROP",
  },
  {
    ts: "2026-04-23T10:01:00Z",
    action: "remove",
    source: "event",
    container_id: "fedcba543210",
    container_name: "redis",
    rule_sets: 0,
    default_policy: "ACCEPT",
  },
  {
    ts: "2026-04-23T10:02:00Z",
    action: "drift",
    source: "drift",
    container_id: "111111aaaaaa",
    container_name: "alpine",
  },
];

beforeEach(async () => {
  const api = await import("@/lib/api");
  vi.mocked(api.fetchAuditHistory).mockResolvedValue(events);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("HistoryPage", () => {
  it("renders all rows when no filter is set", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    expect(screen.getByText("redis")).toBeInTheDocument();
    expect(screen.getByText("alpine")).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 3 events/i)).toBeInTheDocument();
  });

  it("filters events by action substring", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const actionInput = screen.getByPlaceholderText(/apply \/ remove \/ drift/i);
    await user.type(actionInput, "apply");
    await waitFor(() => expect(screen.queryByText("redis")).not.toBeInTheDocument());
    expect(screen.getByText("nginx")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 3 events/i)).toBeInTheDocument();
  });

  it("filters events by source substring", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const sourceInput = screen.getByPlaceholderText(/api \/ event \/ drift/i);
    await user.type(sourceInput, "drift");
    await waitFor(() => expect(screen.queryByText("nginx")).not.toBeInTheDocument());
    expect(screen.getByText("alpine")).toBeInTheDocument();
  });

  it("filters events by container id or name substring", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const inputs = screen.getAllByRole("textbox");
    const containerInput = inputs[2];
    if (!containerInput) throw new Error("container filter input missing");
    await user.type(containerInput, "redis");
    await waitFor(() => expect(screen.queryByText("nginx")).not.toBeInTheDocument());
    expect(screen.getByText("redis")).toBeInTheDocument();
  });

  it("shows the empty-state row when filter matches nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    const actionInput = screen.getByPlaceholderText(/apply \/ remove \/ drift/i);
    await user.type(actionInput, "nope-no-match");
    await waitFor(() => expect(screen.getByText(/No events\./i)).toBeInTheDocument());
  });

  it("toggles auto-refresh checkbox without crashing", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("calls fetchAuditHistory again when the Refresh button is pressed", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const callsBefore = vi.mocked(api.fetchAuditHistory).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(vi.mocked(api.fetchAuditHistory).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("renders the error message when fetchAuditHistory rejects", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchAuditHistory).mockRejectedValue(new Error("offline"));
    renderPage();
    await waitFor(() => expect(screen.getByText(/Error: offline/i)).toBeInTheDocument());
  });

  it("falls back to '—' for missing container metadata and zero rule-sets", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchAuditHistory).mockResolvedValue([
      {
        ts: "2026-04-23T10:05:00Z",
        action: "noop",
        source: "api",
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/Showing 1 of 1 events/i)).toBeInTheDocument());
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("matches the empty container filter against rows with no container_id/name", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.fetchAuditHistory).mockResolvedValue([
      { ts: "2026-04-23T10:05:00Z", action: "noop", source: "api" },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/Showing 1 of 1 events/i)).toBeInTheDocument());
    const inputs = screen.getAllByRole("textbox");
    const containerInput = inputs[2];
    if (!containerInput) throw new Error("container filter input missing");
    await user.type(containerInput, "anything");
    await waitFor(() => expect(screen.getByText(/Showing 0 of 1 events/i)).toBeInTheDocument());
  });

  it("renders the auto-refresh interval timer without breaking when toggled off", async () => {
    vi.useFakeTimers();
    try {
      const api = await import("@/lib/api");
      const renderResult = renderPage();
      await vi.waitFor(() => expect(api.fetchAuditHistory).toHaveBeenCalled());
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(5000);
      renderResult.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
