import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutogenApproveResponse, AutogenProposal } from "@/types/api";
import ProposalsPage from "./ProposalsPage";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  fetchAutogenProposals: vi.fn(),
  approveAutogen: vi.fn(),
  rejectAutogen: vi.fn(),
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
      <ProposalsPage />
    </QueryClientProvider>,
  );
}

const pendingHigh: AutogenProposal = {
  container_id: "abcdef012345aaaa",
  ports: [80, 443],
  peers: ["10.0.0.1", "10.0.0.2"],
  observed_for: "12h",
  confidence: "high",
  status: "pending",
};

const pendingMod: AutogenProposal = {
  container_id: "fedcba543210bbbb",
  ports: [22],
  peers: ["192.168.1.1"],
  observed_for: "2h",
  confidence: "moderate",
  status: "pending",
};

const approvedT: AutogenProposal = {
  container_id: "1111aaaa2222bbbb",
  ports: [3306],
  peers: [],
  observed_for: "30m",
  confidence: "tentative",
  status: "approved",
  decided_by: "alice",
  decided_at: "2026-04-23T09:00:00Z",
  reason: "looks fine",
};

beforeEach(async () => {
  const api = await import("@/lib/api");
  vi.mocked(api.fetchAutogenProposals).mockResolvedValue([pendingHigh, pendingMod, approvedT]);
  vi.mocked(api.approveAutogen).mockResolvedValue({
    mode: "labels",
    snippet: 'labels:\n  firefik.enable: "true"',
    container_id: pendingHigh.container_id,
    ports: pendingHigh.ports,
    peers: pendingHigh.peers,
  } satisfies AutogenApproveResponse);
  vi.mocked(api.rejectAutogen).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProposalsPage", () => {
  it("defaults to the pending bucket and lists pending proposals only", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );
    expect(screen.getByText(pendingMod.container_id.slice(0, 12))).toBeInTheDocument();
    expect(screen.queryByText(approvedT.container_id.slice(0, 12))).not.toBeInTheDocument();
  });

  it("switches to the approved bucket when the filter button is pressed", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "approved" }));
    await waitFor(() =>
      expect(screen.getByText(approvedT.container_id.slice(0, 12))).toBeInTheDocument(),
    );
    expect(screen.queryByText(pendingHigh.container_id.slice(0, 12))).not.toBeInTheDocument();
  });

  it("shows an empty bucket message when no proposals match the filter", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "rejected" }));
    await waitFor(() =>
      expect(screen.getByText(/No proposals in this bucket/i)).toBeInTheDocument(),
    );
  });

  it("approves the active proposal as labels and renders the snippet panel", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Approve → labels/i }));
    const api = await import("@/lib/api");
    await waitFor(() =>
      expect(api.approveAutogen).toHaveBeenCalledWith(
        pendingHigh.container_id,
        "labels",
        undefined,
      ),
    );
    await waitFor(() => expect(screen.getByText(/docker-compose labels/i)).toBeInTheDocument());
  });

  it("approves as policy when the policy button is pressed", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.approveAutogen).mockResolvedValue({
      mode: "policy",
      snippet: "policy { allow tcp 80 }",
      container_id: pendingHigh.container_id,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Approve → policy snippet/i }));
    await waitFor(() =>
      expect(api.approveAutogen).toHaveBeenCalledWith(
        pendingHigh.container_id,
        "policy",
        undefined,
      ),
    );
    await waitFor(() => expect(screen.getByText(/policy DSL/i)).toBeInTheDocument());
  });

  it("rejects the active proposal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));
    const api = await import("@/lib/api");
    await waitFor(() =>
      expect(api.rejectAutogen).toHaveBeenCalledWith(
        pendingHigh.container_id,
        undefined,
        undefined,
      ),
    );
  });

  it("selects a different proposal when its row is clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingMod.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByText(pendingMod.container_id.slice(0, 12)));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: pendingMod.container_id })).toBeInTheDocument(),
    );
  });

  it("surfaces approve errors via toast", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.approveAutogen).mockRejectedValue(new Error("boom"));
    const { toast } = await import("sonner");
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Approve → labels/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Approve failed")),
    );
  });

  it("surfaces reject errors via toast", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.rejectAutogen).mockRejectedValue(new Error("oops"));
    const { toast } = await import("sonner");
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Reject failed")),
    );
  });

  it("renders warming-tier badge styling and 'pending' fallback for missing confidence/status", async () => {
    const api = await import("@/lib/api");
    const warming: AutogenProposal = {
      container_id: "warmingaaaa1111",
      ports: [],
      peers: [],
      observed_for: "5m",
      confidence: "warming",
      status: "pending",
    };
    const noConfidence: AutogenProposal = {
      container_id: "noconfid22221111",
      observed_for: "1m",
    };
    vi.mocked(api.fetchAutogenProposals).mockResolvedValue([warming, noConfidence]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(warming.container_id.slice(0, 12))).toBeInTheDocument(),
    );
    expect(screen.getByText("warming")).toBeInTheDocument();
    expect(screen.getAllByText("pending").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0 ports · 0 peers/).length).toBeGreaterThan(0);
  });

  it("renders decided_by metadata without decided_at/reason when those are absent", async () => {
    const api = await import("@/lib/api");
    const decided: AutogenProposal = {
      container_id: "decidedaaaa1111",
      ports: [80],
      peers: ["1.1.1.1"],
      observed_for: "1h",
      confidence: "high",
      status: "approved",
      decided_by: "alice",
    };
    vi.mocked(api.fetchAutogenProposals).mockResolvedValue([decided]);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "approved" }));
    await waitFor(() =>
      expect(screen.getByText(decided.container_id.slice(0, 12))).toBeInTheDocument(),
    );
    expect(screen.getByText(/Last decision:/)).toBeInTheDocument();
    expect(screen.queryByText(/at 2026/)).not.toBeInTheDocument();
  });

  it("copies the approved snippet to the clipboard and toasts success", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Approve → labels/i }));
    await waitFor(() => expect(screen.getByText(/docker-compose labels/i)).toBeInTheDocument());

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Copied."));
  });

  it("toasts an error if clipboard write fails", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(pendingHigh.container_id.slice(0, 12))).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Approve → labels/i }));
    await waitFor(() => expect(screen.getByText(/docker-compose labels/i)).toBeInTheDocument());

    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Copy failed."));
  });
});
