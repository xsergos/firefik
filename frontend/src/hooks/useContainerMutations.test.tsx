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
    expect(toast.success).toHaveBeenCalledWith("Firewall rules applied");
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
  it("invalidates keys and shows deactivation toast", async () => {
    const api = await loadApi();
    vi.mocked(api.deactivateContainerRules).mockResolvedValue(undefined);
    const { spy, Wrapper } = makeWrapper();

    const { result } = renderHook(() => useDeactivateContainer(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync("abc123");
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(invalidateAfterMutation.length));
    expect(toast.success).toHaveBeenCalledWith("Firewall rules deactivated");
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
    expect(toast.success).toHaveBeenCalledWith("Bulk: 2 applied, 1 disabled");
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
