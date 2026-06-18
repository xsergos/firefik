import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingApproval } from "@/lib/controlPlaneApi";
import ApprovalsPage from "./ApprovalsPage";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/lib/controlPlaneApi", () => ({
  fetchApprovals: vi.fn(),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ApprovalsPage />
    </QueryClientProvider>,
  );
}

const pending: PendingApproval = {
  id: "ap-pending",
  policy_name: "web-allow",
  proposed_body: "policy 'web' { allow }",
  requester: "bob",
  requester_fingerprint: "sha256:bob",
  requested_at: "2026-04-23T10:00:00Z",
  approver: "",
  approver_fingerprint: "",
  approved_at: null,
  status: "pending",
  rejection_comment: "",
};

const approved: PendingApproval = {
  id: "ap-approved",
  policy_name: "db-deny",
  proposed_body: "policy 'db' { deny }",
  requester: "carol",
  requester_fingerprint: "sha256:carol",
  requested_at: "2026-04-22T10:00:00Z",
  approver: "alice",
  approver_fingerprint: "sha256:alice",
  approved_at: "2026-04-22T11:00:00Z",
  status: "approved",
  rejection_comment: "",
};

const rejected: PendingApproval = {
  id: "ap-rejected",
  policy_name: "cache-open",
  proposed_body: "policy 'cache' { allow }",
  requester: "dave",
  requester_fingerprint: "sha256:dave",
  requested_at: "2026-04-21T10:00:00Z",
  approver: "alice",
  approver_fingerprint: "sha256:alice",
  approved_at: "2026-04-21T11:00:00Z",
  status: "rejected",
  rejection_comment: "too risky",
};

beforeEach(async () => {
  const api = await import("@/lib/controlPlaneApi");
  vi.mocked(api.fetchApprovals).mockImplementation(async (status?: string) => {
    if (status === "approved") return [approved];
    if (status === "rejected") return [rejected];
    if (status === "pending") return [pending];
    return [pending, approved, rejected];
  });
  vi.mocked(api.approveApproval).mockResolvedValue({
    ...pending,
    status: "approved",
    approver: "alice",
    approved_at: "2026-04-23T11:00:00Z",
  });
  vi.mocked(api.rejectApproval).mockResolvedValue({
    ...pending,
    status: "rejected",
    approver: "alice",
    approved_at: "2026-04-23T11:00:00Z",
    rejection_comment: "no",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ApprovalsPage", () => {
  it("renders pending approvals only by default", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());
    expect(screen.queryByText("db-deny")).not.toBeInTheDocument();
    expect(screen.queryByText("cache-open")).not.toBeInTheDocument();
  });

  it("switches the status filter via the filter buttons", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/controlPlaneApi");
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "approved" }));
    await waitFor(() => expect(screen.getByText("db-deny")).toBeInTheDocument());
    expect(api.fetchApprovals).toHaveBeenCalledWith("approved");

    await user.click(screen.getByRole("button", { name: "rejected" }));
    await waitFor(() => expect(screen.getByText("cache-open")).toBeInTheDocument());
    expect(api.fetchApprovals).toHaveBeenCalledWith("rejected");

    await user.click(screen.getByRole("button", { name: "all" }));
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());
    expect(api.fetchApprovals).toHaveBeenCalledWith("");
  });

  it("requires an approver name before approving and shows a success toast on approve", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/controlPlaneApi");
    const { toast } = await import("sonner");
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    const approveBtn = screen.getByRole("button", { name: "Approve" });
    expect(approveBtn).toBeDisabled();

    await user.type(screen.getByPlaceholderText("approver name"), "alice");
    expect(approveBtn).toBeEnabled();
    await user.click(approveBtn);

    await waitFor(() => expect(api.approveApproval).toHaveBeenCalledWith("ap-pending", "alice"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Approval recorded"));
  });

  it("rejects with optional comment and shows an info toast", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/controlPlaneApi");
    const { toast } = await import("sonner");
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("approver name"), "alice");
    await user.type(screen.getByPlaceholderText(/rejection comment/i), "too broad");
    await user.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(api.rejectApproval).toHaveBeenCalledWith("ap-pending", "alice", "too broad"),
    );
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Approval rejected"));
  });

  it("surfaces a 403 self-approve error via toast.error", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/controlPlaneApi");
    const { toast } = await import("sonner");
    vi.mocked(api.approveApproval).mockRejectedValue(new Error("self-approval forbidden"));
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("approver name"), "bob");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("self-approval forbidden"));
  });

  it("does NOT show approve/reject buttons on approved or rejected cards", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "approved" }));
    await waitFor(() => expect(screen.getByText("db-deny")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(screen.getByText(/approved by/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "rejected" }));
    await waitFor(() => expect(screen.getByText("cache-open")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(screen.getByText(/too risky/i)).toBeInTheDocument();
  });

  it("renders an empty state when no approvals match", async () => {
    const api = await import("@/lib/controlPlaneApi");
    vi.mocked(api.fetchApprovals).mockResolvedValue([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No approvals match the selected status/i)).toBeInTheDocument(),
    );
  });

  it("renders the error state when fetch fails", async () => {
    const api = await import("@/lib/controlPlaneApi");
    vi.mocked(api.fetchApprovals).mockRejectedValue(new Error("upstream down"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/upstream down/i)).toBeInTheDocument();
  });

  it("renders an approved card with no approved_at timestamp without crashing", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/controlPlaneApi");
    const noTimestamp: PendingApproval = {
      ...approved,
      id: "ap-no-ts",
      policy_name: "no-ts-policy",
      approved_at: null,
      rejection_comment: "",
    };
    vi.mocked(api.fetchApprovals).mockImplementation(async (status?: string) => {
      if (status === "approved") return [noTimestamp];
      return [];
    });
    renderPage();
    await user.click(screen.getByRole("button", { name: "approved" }));
    await waitFor(() => expect(screen.getByText("no-ts-policy")).toBeInTheDocument());
    expect(screen.getByText(/approved by/i)).toBeInTheDocument();
  });

  it("surfaces reject errors via toast.error", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/controlPlaneApi");
    const { toast } = await import("sonner");
    vi.mocked(api.rejectApproval).mockRejectedValue(new Error("nope"));
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("approver name"), "alice");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
  });
});
