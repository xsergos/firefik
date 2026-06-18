import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIError,
  applyContainerRules,
  approveAutogen,
  bulkContainerActions,
  deactivateContainerRules,
  fetchAuditHistory,
  fetchAutogenProposals,
  fetchContainers,
  fetchPolicies,
  fetchPolicy,
  fetchRules,
  fetchStats,
  rejectAutogen,
  savePolicy,
  simulatePolicy,
  validatePolicy,
  wsLogsUrl,
} from "@/lib/api";

const originalFetch = globalThis.fetch;

function mockJSON(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function mockText(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function installFetch(impl: typeof fetch) {
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("APIError", () => {
  it("surfaces a user-friendly message and preserves raw details", () => {
    const err = new APIError(500, "apply_failed", "Failed to apply rules.", "boom");
    expect(err.userMessage).toBe("Failed to apply rules.");
    expect(err.code).toBe("apply_failed");
    expect(err.details).toBe("boom");
    expect(err.status).toBe(500);
    expect(err.name).toBe("APIError");
    expect(err.message).toContain("500");
    expect(err.message).toContain("apply_failed");
  });

  it("allows omitting details", () => {
    const err = new APIError(404, "container_not_found", "Gone.");
    expect(err.details).toBeUndefined();
  });
});

describe("fetchContainers", () => {
  it("parses a successful response", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON(
          [
            {
              id: "abcdef012345",
              name: "nginx",
              status: "running",
              enabled: true,
              firewallStatus: "active",
              labels: { "firefik.enable": "true" },
            },
          ],
          { status: 200 },
        ),
      ) as typeof fetch,
    );
    const out = await fetchContainers();
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("abcdef012345");
  });

  it("throws APIError on non-OK status with typed body", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "docker_unavailable", message: "dead" }, { status: 500 }),
      ) as typeof fetch,
    );
    await expect(fetchContainers()).rejects.toMatchObject({
      name: "APIError",
      status: 500,
      code: "docker_unavailable",
    });
  });

  it("falls back to internal_error when error body is not parseable", async () => {
    installFetch(vi.fn(async () => mockText("not json", { status: 503 })) as typeof fetch);
    await expect(fetchContainers()).rejects.toMatchObject({
      name: "APIError",
      status: 503,
      code: "internal_error",
    });
  });

  it("falls back to internal_error when error body fails schema", async () => {
    installFetch(
      vi.fn(async () => mockJSON({ unexpected: true }, { status: 502 })) as typeof fetch,
    );
    await expect(fetchContainers()).rejects.toMatchObject({
      code: "internal_error",
      status: 502,
    });
  });

  it("throws schema_mismatch APIError when payload shape is wrong", async () => {
    installFetch(vi.fn(async () => mockJSON({ nope: 1 }, { status: 200 })) as typeof fetch);
    await expect(fetchContainers()).rejects.toMatchObject({
      name: "APIError",
      code: "schema_mismatch",
    });
  });

  it("wraps timeout abort as timeout APIError", async () => {
    vi.useFakeTimers();
    installFetch(
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }) as typeof fetch,
    );
    const p = fetchContainers();
    vi.advanceTimersByTime(20_000);
    await expect(p).rejects.toMatchObject({ code: "timeout", status: 0 });
    vi.useRealTimers();
  });

  it("propagates abort from caller signal without wrapping", async () => {
    installFetch(
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }) as typeof fetch,
    );
    const ctrl = new AbortController();
    const p = fetchContainers({ signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toBeDefined();
  });

  it("rethrows non-abort fetch errors unchanged", async () => {
    const err = new Error("net down");
    installFetch(
      vi.fn(async () => {
        throw err;
      }) as typeof fetch,
    );
    await expect(fetchContainers()).rejects.toBe(err);
  });
});

describe("fetchStats", () => {
  it("returns stats DTO on success", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON(
          {
            containers: { total: 2, running: 1, enabled: 1 },
            traffic: [{ ts: "2026-04-23T10:00:00Z", accepted: 10, dropped: 1 }],
          },
          { status: 200 },
        ),
      ) as typeof fetch,
    );
    const out = await fetchStats();
    expect(out.containers.total).toBe(2);
    expect(out.traffic).toHaveLength(1);
  });

  it("throws APIError on 500", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "internal_error", message: "oops" }, { status: 500 }),
      ) as typeof fetch,
    );
    await expect(fetchStats()).rejects.toMatchObject({ status: 500, code: "internal_error" });
  });

  it("throws on schema mismatch", async () => {
    installFetch(vi.fn(async () => mockJSON({ bad: true }, { status: 200 })) as typeof fetch);
    await expect(fetchStats()).rejects.toMatchObject({ code: "schema_mismatch" });
  });
});

describe("fetchRules", () => {
  it("parses rules list", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON(
          [
            {
              containerID: "c1",
              containerName: "n1",
              status: "running",
              defaultPolicy: "DROP",
              ruleSets: [],
            },
          ],
          { status: 200 },
        ),
      ) as typeof fetch,
    );
    const out = await fetchRules();
    expect(out).toHaveLength(1);
    expect(out[0]?.defaultPolicy).toBe("DROP");
  });

  it("throws APIError on 4xx with typed body", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "invalid_id", message: "bad id" }, { status: 400 }),
      ) as typeof fetch,
    );
    await expect(fetchRules()).rejects.toMatchObject({ status: 400, code: "invalid_id" });
  });

  it("throws on schema mismatch", async () => {
    installFetch(vi.fn(async () => mockJSON({ foo: 1 }, { status: 200 })) as typeof fetch);
    await expect(fetchRules()).rejects.toMatchObject({ code: "schema_mismatch" });
  });
});

describe("fetchAuditHistory", () => {
  it("parses list with no limit", async () => {
    const seen: string[] = [];
    installFetch(
      vi.fn(async (url: RequestInfo | URL) => {
        seen.push(String(url));
        return mockJSON([{ ts: "2026-04-23T10:00:00Z", action: "apply", source: "user" }], {
          status: 200,
        });
      }) as typeof fetch,
    );
    const out = await fetchAuditHistory();
    expect(out).toHaveLength(1);
    expect(seen[0]).toMatch(/\/api\/audit\/history$/);
  });

  it("appends limit query when provided", async () => {
    const seen: string[] = [];
    installFetch(
      vi.fn(async (url: RequestInfo | URL) => {
        seen.push(String(url));
        return mockJSON([], { status: 200 });
      }) as typeof fetch,
    );
    await fetchAuditHistory(25);
    expect(seen[0]).toContain("?limit=25");
  });

  it("throws on schema mismatch", async () => {
    installFetch(vi.fn(async () => mockJSON({ no: true }, { status: 200 })) as typeof fetch);
    await expect(fetchAuditHistory()).rejects.toMatchObject({ code: "schema_mismatch" });
  });
});

describe("wsLogsUrl", () => {
  it("uses window.location when BASE_URL is empty and https", () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "https:", host: "example.com" } as Location,
    });
    try {
      expect(wsLogsUrl()).toBe("wss://example.com/ws/logs");
      expect(wsLogsUrl("DROP")).toBe("wss://example.com/ws/logs?filter=DROP");
    } finally {
      if (prev) Object.defineProperty(globalThis, "location", prev);
    }
  });

  it("uses ws:// when http", () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:3000" } as Location,
    });
    try {
      expect(wsLogsUrl()).toBe("ws://localhost:3000/ws/logs");
    } finally {
      if (prev) Object.defineProperty(globalThis, "location", prev);
    }
  });

  it("url-encodes the filter", () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "http:", host: "h" } as Location,
    });
    try {
      expect(wsLogsUrl("a b&c")).toContain("filter=a%20b%26c");
    } finally {
      if (prev) Object.defineProperty(globalThis, "location", prev);
    }
  });
});

describe("applyContainerRules", () => {
  it("resolves on 2xx", async () => {
    const fn = vi.fn(async () => new Response(null, { status: 204 }));
    installFetch(fn as typeof fetch);
    await expect(applyContainerRules("abc")).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining("/api/containers/abc/apply"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws APIError with typed body on error", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "apply_failed", message: "nope" }, { status: 500 }),
      ) as typeof fetch,
    );
    await expect(applyContainerRules("abc")).rejects.toMatchObject({
      code: "apply_failed",
      userMessage: "Failed to apply firewall rules.",
    });
  });

  it("falls back to internal_error on non-parseable body", async () => {
    installFetch(vi.fn(async () => mockText("oops", { status: 502 })) as typeof fetch);
    await expect(applyContainerRules("x")).rejects.toMatchObject({
      code: "internal_error",
      status: 502,
    });
  });
});

describe("deactivateContainerRules", () => {
  it("resolves on 2xx", async () => {
    const fn = vi.fn(async () => new Response(null, { status: 204 }));
    installFetch(fn as typeof fetch);
    await expect(deactivateContainerRules("zz")).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining("/api/containers/zz/disable"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws APIError on failure", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "disable_failed", message: "nope" }, { status: 500 }),
      ) as typeof fetch,
    );
    await expect(deactivateContainerRules("zz")).rejects.toMatchObject({
      code: "disable_failed",
    });
  });
});

describe("bulkContainerActions", () => {
  const actions = [{ id: "a", action: "apply" as const }];
  const payload = {
    results: [{ id: "a", action: "apply", status: "ok" as const }],
    summary: { total: 1, applied: 1, disabled: 0, failed: 0 },
  };

  it("parses bulk response", async () => {
    installFetch(vi.fn(async () => mockJSON(payload, { status: 200 })) as typeof fetch);
    const out = await bulkContainerActions(actions);
    expect(out.summary.applied).toBe(1);
    expect(out.results).toHaveLength(1);
  });

  it("throws APIError with typed body", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "invalid_id", message: "bad" }, { status: 400 }),
      ) as typeof fetch,
    );
    await expect(bulkContainerActions(actions)).rejects.toMatchObject({
      status: 400,
      code: "invalid_id",
    });
  });

  it("falls back to internal_error when body is unparseable", async () => {
    installFetch(vi.fn(async () => mockText("broken", { status: 500 })) as typeof fetch);
    await expect(bulkContainerActions(actions)).rejects.toMatchObject({
      code: "internal_error",
    });
  });

  it("throws schema_mismatch on malformed OK body", async () => {
    installFetch(vi.fn(async () => mockJSON({ results: "nope" }, { status: 200 })) as typeof fetch);
    await expect(bulkContainerActions(actions)).rejects.toMatchObject({
      code: "schema_mismatch",
    });
  });
});

describe("fetchPolicies", () => {
  it("parses policy list", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON([{ name: "p1", version: "v1", source: "/x", rules: 2 }], { status: 200 }),
      ) as typeof fetch,
    );
    const out = await fetchPolicies();
    expect(out[0]?.name).toBe("p1");
  });

  it("throws APIError on 500", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "internal_error", message: "boom" }, { status: 500 }),
      ) as typeof fetch,
    );
    await expect(fetchPolicies()).rejects.toMatchObject({ status: 500 });
  });

  it("throws on schema mismatch", async () => {
    installFetch(vi.fn(async () => mockJSON({ wrong: 1 }, { status: 200 })) as typeof fetch);
    await expect(fetchPolicies()).rejects.toMatchObject({ code: "schema_mismatch" });
  });
});

describe("fetchPolicy", () => {
  it("encodes the name in the URL", async () => {
    const seen: string[] = [];
    installFetch(
      vi.fn(async (url: RequestInfo | URL) => {
        seen.push(String(url));
        return mockJSON(
          { name: "a/b", version: "v1", dsl: "policy", ruleSets: [] },
          { status: 200 },
        );
      }) as typeof fetch,
    );
    await fetchPolicy("a/b");
    expect(seen[0]).toContain("/api/policies/a%2Fb");
  });

  it("throws on schema mismatch", async () => {
    installFetch(vi.fn(async () => mockJSON({ name: 1 }, { status: 200 })) as typeof fetch);
    await expect(fetchPolicy("x")).rejects.toMatchObject({ code: "schema_mismatch" });
  });

  it("throws APIError on 404", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "not_found", message: "nope" }, { status: 404 }),
      ) as typeof fetch,
    );
    await expect(fetchPolicy("x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("validatePolicy", () => {
  it("parses validation response", async () => {
    installFetch(vi.fn(async () => mockJSON({ ok: true }, { status: 200 })) as typeof fetch);
    const out = await validatePolicy("policy 'p' {}");
    expect(out.ok).toBe(true);
  });

  it("throws APIError with typed body", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "internal_error", message: "x" }, { status: 500 }),
      ) as typeof fetch,
    );
    await expect(validatePolicy("x")).rejects.toMatchObject({ status: 500 });
  });

  it("throws internal_error when body is not parseable on error", async () => {
    installFetch(vi.fn(async () => mockText("rip", { status: 500 })) as typeof fetch);
    await expect(validatePolicy("x")).rejects.toMatchObject({
      code: "internal_error",
    });
  });

  it("throws schema_mismatch on malformed success body", async () => {
    installFetch(vi.fn(async () => mockJSON({ nope: 1 }, { status: 200 })) as typeof fetch);
    await expect(validatePolicy("x")).rejects.toMatchObject({ code: "schema_mismatch" });
  });
});

describe("simulatePolicy", () => {
  it("parses simulation response", async () => {
    installFetch(
      vi.fn(async () => mockJSON({ policy: "p", ruleSets: [] }, { status: 200 })) as typeof fetch,
    );
    const out = await simulatePolicy("p", { containerID: "c" });
    expect(out.policy).toBe("p");
  });

  it("throws APIError with typed body", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "container_not_found", message: "nope" }, { status: 404 }),
      ) as typeof fetch,
    );
    await expect(simulatePolicy("p", {})).rejects.toMatchObject({
      code: "container_not_found",
    });
  });

  it("falls back to internal_error when body is unparseable", async () => {
    installFetch(vi.fn(async () => mockText("x", { status: 500 })) as typeof fetch);
    await expect(simulatePolicy("p", {})).rejects.toMatchObject({ code: "internal_error" });
  });

  it("throws schema_mismatch on malformed body", async () => {
    installFetch(vi.fn(async () => mockJSON({ not: "right" }, { status: 200 })) as typeof fetch);
    await expect(simulatePolicy("p", {})).rejects.toMatchObject({ code: "schema_mismatch" });
  });
});

describe("savePolicy", () => {
  it("returns the parsed response on 2xx", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ name: "p", version: "v1", rules: 0 }, { status: 200 }),
      ) as typeof fetch,
    );
    const out = await savePolicy("p", "dsl", "comment");
    expect(out.name).toBe("p");
  });

  it("throws APIError with typed body", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "invalid_id", message: "bad" }, { status: 400 }),
      ) as typeof fetch,
    );
    await expect(savePolicy("p", "d")).rejects.toMatchObject({ status: 400 });
  });

  it("falls back to internal_error on unparseable error body", async () => {
    installFetch(vi.fn(async () => mockText("nope", { status: 500 })) as typeof fetch);
    await expect(savePolicy("p", "d")).rejects.toMatchObject({ code: "internal_error" });
  });

  it("sends PUT with dsl and comment", async () => {
    const fn = vi.fn(async () =>
      mockJSON({ name: "p", version: "v1", rules: 0 }, { status: 200 }),
    ) as typeof fetch;
    installFetch(fn);
    await savePolicy("p", "dsl-body", "note");
    const call = (fn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    if (!call) throw new Error("fetch not called");
    expect(call[1].method).toBe("PUT");
    expect(String(call[1].body)).toContain("dsl-body");
    expect(String(call[1].body)).toContain("note");
  });
});

describe("fetchAutogenProposals", () => {
  it("parses autogen list", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON([{ container_id: "c1", ports: [80] }], { status: 200 }),
      ) as typeof fetch,
    );
    const out = await fetchAutogenProposals();
    expect(out[0]?.container_id).toBe("c1");
  });

  it("throws on schema mismatch", async () => {
    installFetch(vi.fn(async () => mockJSON({ nope: 1 }, { status: 200 })) as typeof fetch);
    await expect(fetchAutogenProposals()).rejects.toMatchObject({
      code: "schema_mismatch",
    });
  });
});

describe("approveAutogen", () => {
  it("returns parsed response", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ mode: "labels", snippet: "stuff", container_id: "c1" }, { status: 200 }),
      ) as typeof fetch,
    );
    const out = await approveAutogen("c1", "labels");
    expect(out.mode).toBe("labels");
  });

  it("throws APIError on error", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "internal_error", message: "x" }, { status: 500 }),
      ) as typeof fetch,
    );
    await expect(approveAutogen("c", "policy")).rejects.toMatchObject({
      status: 500,
    });
  });

  it("falls back to internal_error on unparseable body", async () => {
    installFetch(vi.fn(async () => mockText("oops", { status: 500 })) as typeof fetch);
    await expect(approveAutogen("c", "policy")).rejects.toMatchObject({
      code: "internal_error",
    });
  });

  it("throws schema_mismatch on malformed body", async () => {
    installFetch(vi.fn(async () => mockJSON({ mode: "unknown" }, { status: 200 })) as typeof fetch);
    await expect(approveAutogen("c", "labels")).rejects.toMatchObject({
      code: "schema_mismatch",
    });
  });
});

describe("rejectAutogen", () => {
  it("resolves on 2xx", async () => {
    installFetch(vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch);
    await expect(rejectAutogen("c1", "reason")).resolves.toBeUndefined();
  });

  it("resolves with no reason", async () => {
    installFetch(vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch);
    await expect(rejectAutogen("c1")).resolves.toBeUndefined();
  });

  it("throws APIError with typed body", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ code: "container_not_found", message: "nope" }, { status: 404 }),
      ) as typeof fetch,
    );
    await expect(rejectAutogen("c1")).rejects.toMatchObject({ status: 404 });
  });

  it("falls back to internal_error when body is unparseable", async () => {
    installFetch(vi.fn(async () => mockText("x", { status: 500 })) as typeof fetch);
    await expect(rejectAutogen("c1")).rejects.toMatchObject({
      code: "internal_error",
    });
  });
});
