import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APIError } from "@/lib/api";
import { invalidateAfterMutation } from "@/lib/queryKeys";
import {
  useApplyContainer,
  useBulkContainers,
  useDeactivateContainer,
  unconfirmedToastMessage,
  usePendingFirewall,
  type PendingTarget,
} from "./useContainerMutations";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    applyContainerRules: vi.fn(),
    deactivateContainerRules: vi.fn(),
    bulkContainerActions: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const spy = vi.spyOn(client, "invalidateQueries");
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, spy, Wrapper };
}

async function loadApi() {
  return await import("@/lib/api");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useApplyContainer", () => {
  it("invalidates every key in invalidateAfterMutation on success", async () => {
    const api = await loadApi();
    vi.mocked(api.applyContainerRules).mockResolvedValue(undefined);
    const { spy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useApplyContainer(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync("abc123");
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(invalidateAfterMutation.length));
    const invalidatedKeys = spy.mock.calls.map((c) => c[0]?.queryKey);
    for (const expected of invalidateAfterMutation) {
      expect(invalidatedKeys).toContainEqual(expected);
    }
    expect(toast.success).toHaveBeenCalledWith("Rules applied to abc123");
  });

  it("surfaces userMessage via toast when APIError is thrown", async () => {
    const api = await loadApi();
    const err = new APIError(500, "apply_failed", "Failed to apply firewall rules.", "boom");
    vi.mocked(api.applyContainerRules).mockRejectedValue(err);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useApplyContainer(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync("abc123")).rejects.toBe(err);
    });

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to apply firewall rules."),
    );
  });

  it("shows generic fallback when a non-APIError propagates", async () => {
    const api = await loadApi();
    vi.mocked(api.applyContainerRules).mockRejectedValue(new Error("raw error"));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useApplyContainer(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync("abc123")).rejects.toThrow("raw error");
    });

    expect(toast.error).toHaveBeenCalledWith("Apply rules failed.");
  });
});

describe("useDeactivateContainer", () => {
  it("invalidates keys and shows the turn off toast", async () => {
    const api = await loadApi();
    vi.mocked(api.deactivateContainerRules).mockResolvedValue(undefined);
    const { spy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeactivateContainer(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync("abc123");
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(invalidateAfterMutation.length));
    expect(toast.success).toHaveBeenCalledWith("Firewall turned off for abc123");
  });

  it("surfaces APIError details on deactivation failure", async () => {
    const api = await loadApi();
    const err = new APIError(409, "deactivate_failed", "Could not deactivate.", "conflict");
    vi.mocked(api.deactivateContainerRules).mockRejectedValue(err);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeactivateContainer(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync("abc")).rejects.toBe(err);
    });

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Could not deactivate."));
  });
});

describe("useBulkContainers", () => {
  it("shows a success toast when no actions failed", async () => {
    const api = await loadApi();
    vi.mocked(api.bulkContainerActions).mockResolvedValue({
      summary: { total: 3, applied: 2, disabled: 1, failed: 0 },
      results: [],
    });
    const { spy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useBulkContainers(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync([
        { id: "a", action: "apply" },
        { id: "b", action: "apply" },
        { id: "c", action: "disable" },
      ]);
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(invalidateAfterMutation.length));
    expect(toast.success).toHaveBeenCalledWith(
      "Bulk: applied 2 containers and turned off 1 container",
    );
  });

  it("emits a warning toast when some actions failed (mixed result)", async () => {
    const api = await loadApi();
    vi.mocked(api.bulkContainerActions).mockResolvedValue({
      summary: { total: 3, applied: 1, disabled: 0, failed: 2 },
      results: [],
    });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useBulkContainers(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync([
        { id: "a", action: "apply" },
        { id: "b", action: "apply" },
        { id: "c", action: "apply" },
      ]);
    });

    expect(toast.warning).toHaveBeenCalledWith("Bulk: 1/3 succeeded (2 failed)");
  });

  it("surfaces APIError via toast when the bulk request itself fails", async () => {
    const api = await loadApi();
    const err = new APIError(500, "bulk_failed", "Bulk update failed.", "boom");
    vi.mocked(api.bulkContainerActions).mockRejectedValue(err);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useBulkContainers(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync([{ id: "a", action: "apply" }])).rejects.toBe(err);
    });

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Bulk update failed."));
  });

  it("falls back to a generic toast for non-APIError bulk failures", async () => {
    const api = await loadApi();
    vi.mocked(api.bulkContainerActions).mockRejectedValue(new Error("network"));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useBulkContainers(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync([{ id: "a", action: "apply" }])).rejects.toThrow(
        "network",
      );
    });

    expect(toast.error).toHaveBeenCalledWith("Bulk update failed.");
  });
});

describe("agent-aware toasts", () => {
  it("says the apply was sent to the agent instead of claiming it is done", async () => {
    const api = await loadApi();
    vi.mocked(api.applyContainerRules).mockResolvedValue(undefined);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useApplyContainer(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "abc", agent_id: "local-01", name: "web" });
    });
    expect(toast.success).toHaveBeenCalledWith("Sent to local-01: applying rules to web…");
  });

  it("says the turn off was sent to the agent", async () => {
    const api = await loadApi();
    vi.mocked(api.deactivateContainerRules).mockResolvedValue(undefined);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useDeactivateContainer(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "abc", agent_id: "local-01", name: "web" });
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Sent to local-01: turning off the firewall for web…",
    );
  });

  it("summarises bulk actions sent to one agent", async () => {
    const api = await loadApi();
    vi.mocked(api.bulkContainerActions).mockResolvedValue({
      summary: { total: 1, applied: 1, disabled: 0, failed: 0 },
      results: [],
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useBulkContainers(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync([{ id: "a", action: "apply", agent_id: "local-01" }]);
    });
    expect(toast.success).toHaveBeenCalledWith("Sent to local-01: applying rules to 1 container…");
  });
});

describe("usePendingFirewall", () => {
  const target =
    (status: string) =>
    (id: string): PendingTarget => ({ status, name: `ctr-${id}`, agentID: "local-01" });

  it("stays pending until a refresh shows the expected state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result, rerender } = renderHook(({ at }) => usePendingFirewall(at, target("active")), {
      initialProps: { at: 500 },
    });
    act(() => result.current.mark(["c1"], "off"));
    expect(result.current.pendingFor("c1", "active")).toBe("off");
    rerender({ at: 2_000 });
    expect(result.current.pendingFor("c1", "active")).toBe("off");
    expect(result.current.pendingFor("c1", "disabled")).toBeNull();
    vi.useRealTimers();
  });

  it("keeps a re-apply pending until data newer than the request arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result, rerender } = renderHook(({ at }) => usePendingFirewall(at, target("active")), {
      initialProps: { at: 500 },
    });
    act(() => result.current.mark(["c1"], "apply"));
    expect(result.current.pendingFor("c1", "active")).toBe("apply");
    rerender({ at: 1_500 });
    expect(result.current.pendingFor("c1", "active")).toBeNull();
    vi.useRealTimers();
  });

  it("can be cleared on error", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePendingFirewall(0, target("disabled")));
    act(() => result.current.mark(["c1", "c2"], "apply"));
    act(() => result.current.clear(["c2"]));
    expect(result.current.pendingFor("c2", "disabled")).toBeNull();
    expect(result.current.pendingFor("c1", "disabled")).toBe("apply");
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("warns and keeps a not confirmed marker when the agent never reports the new state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result } = renderHook(() => usePendingFirewall(2_000, target("active")));
    act(() => result.current.mark(["c1"], "off"));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(toast.warning).toHaveBeenCalledWith(
      "local-01 has not confirmed that the firewall is off for ctr-c1 yet",
      expect.anything(),
    );
    expect(result.current.pendingFor("c1", "active")).toBe("unconfirmed");
    expect(result.current.pendingFor("c1", "disabled")).toBeNull();
    vi.useRealTimers();
  });

  it("clears silently when the target state was reached before the timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result, rerender } = renderHook(
      ({ at, status }) => usePendingFirewall(at, target(status)),
      { initialProps: { at: 500, status: "inactive" } },
    );
    act(() => result.current.mark(["c1"], "apply"));
    rerender({ at: 5_000, status: "active" });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(result.current.pendingFor("c1", "inactive")).toBeNull();
    vi.useRealTimers();
  });

  it("forgets containers that disappeared without a warning", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePendingFirewall(0, () => undefined));
    act(() => result.current.mark(["c1"], "apply"));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(result.current.pendingFor("c1", "disabled")).toBeNull();
    vi.useRealTimers();
  });
});

describe("unconfirmedToastMessage", () => {
  it("names the agent, the action and the container", () => {
    expect(unconfirmedToastMessage("apply", "web", "local-01")).toBe(
      "local-01 has not confirmed that rules are applied to web yet",
    );
    expect(unconfirmedToastMessage("off", "web")).toBe(
      "Firefik has not confirmed that the firewall is off for web yet",
    );
  });
});
