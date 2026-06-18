import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveApproval,
  createApproval,
  fetchApprovals,
  fetchTemplate,
  fetchTemplates,
  publishTemplate,
  rejectApproval,
} from "@/lib/controlPlaneApi";
import { APIError } from "@/lib/api";

const originalFetch = globalThis.fetch;

function mockJSON(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function installFetch(impl: typeof fetch) {
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const validTemplate = {
  name: "web-allow",
  version: 1,
  body: "policy 'web' { allow }",
  labels: { tier: "edge" },
  publisher: "alice",
  created_at: "2026-04-23T10:00:00Z",
  updated_at: "2026-04-23T10:05:00Z",
};

const validApproval = {
  id: "ap-1",
  policy_name: "web-allow",
  proposed_body: "policy 'web' { allow }",
  requester: "bob",
  requester_fingerprint: "sha256:abc",
  requested_at: "2026-04-23T10:00:00Z",
  approver: "",
  approver_fingerprint: "",
  approved_at: null,
  status: "pending" as const,
  rejection_comment: "",
};

describe.each([
  {
    name: "fetchTemplates",
    call: () => fetchTemplates(),
    okBody: [validTemplate],
    method: "GET",
    urlMatch: /\/api\/templates$/,
    badShape: { not: "array" },
    assertOk: (out: unknown) => {
      expect(Array.isArray(out)).toBe(true);
      expect((out as unknown[]).length).toBe(1);
    },
  },
  {
    name: "fetchTemplate",
    call: () => fetchTemplate("web-allow"),
    okBody: validTemplate,
    method: "GET",
    urlMatch: /\/api\/templates\/web-allow$/,
    badShape: { name: 1 },
    assertOk: (out: unknown) => {
      expect((out as { name: string }).name).toBe("web-allow");
    },
  },
  {
    name: "publishTemplate",
    call: () => publishTemplate({ name: "web-allow", body: "policy 'web' { allow }" }),
    okBody: validTemplate,
    method: "POST",
    urlMatch: /\/api\/templates$/,
    badShape: { name: "x" },
    assertOk: (out: unknown) => {
      expect((out as { version: number }).version).toBe(1);
    },
  },
  {
    name: "fetchApprovals",
    call: () => fetchApprovals("pending"),
    okBody: [validApproval],
    method: "GET",
    urlMatch: /\/api\/approvals\?status=pending$/,
    badShape: { unexpected: true },
    assertOk: (out: unknown) => {
      expect(Array.isArray(out)).toBe(true);
      expect((out as { id: string }[])[0]?.id).toBe("ap-1");
    },
  },
  {
    name: "createApproval",
    call: () =>
      createApproval({
        policy_name: "web-allow",
        proposed_body: "policy 'web' { allow }",
        requester: "bob",
      }),
    okBody: validApproval,
    method: "POST",
    urlMatch: /\/api\/approvals$/,
    badShape: { id: 7 },
    assertOk: (out: unknown) => {
      expect((out as { status: string }).status).toBe("pending");
    },
  },
  {
    name: "approveApproval",
    call: () => approveApproval("ap-1", "alice"),
    okBody: {
      ...validApproval,
      status: "approved",
      approver: "alice",
      approved_at: "2026-04-23T11:00:00Z",
    },
    method: "POST",
    urlMatch: /\/api\/approvals\/ap-1\/approve$/,
    badShape: { status: "weird" },
    assertOk: (out: unknown) => {
      expect((out as { status: string }).status).toBe("approved");
    },
  },
  {
    name: "rejectApproval",
    call: () => rejectApproval("ap-1", "alice", "no thanks"),
    okBody: {
      ...validApproval,
      status: "rejected",
      approver: "alice",
      approved_at: "2026-04-23T11:00:00Z",
      rejection_comment: "no thanks",
    },
    method: "POST",
    urlMatch: /\/api\/approvals\/ap-1\/reject$/,
    badShape: { status: 0 },
    assertOk: (out: unknown) => {
      expect((out as { status: string }).status).toBe("rejected");
    },
  },
])("$name", ({ call, okBody, method, urlMatch, badShape, assertOk }) => {
  it("returns parsed body on 200", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    installFetch(
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(url), init });
        return mockJSON(okBody, { status: 200 });
      }) as typeof fetch,
    );
    const out = await call();
    assertOk(out);
    expect(seen[0]?.url).toMatch(urlMatch);
    expect(seen[0]?.init?.method ?? "GET").toBe(method);
  });

  it("throws APIError on 401", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ message: "unauth" }, { status: 401, statusText: "Unauthorized" }),
      ) as typeof fetch,
    );
    const err = await call().then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(401);
  });

  it("throws APIError on 5xx", async () => {
    installFetch(
      vi.fn(async () =>
        mockJSON({ message: "boom" }, { status: 500, statusText: "Internal" }),
      ) as typeof fetch,
    );
    const err = await call().then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(500);
  });

  it("throws schema_mismatch APIError when payload shape is wrong", async () => {
    installFetch(vi.fn(async () => mockJSON(badShape, { status: 200 })) as typeof fetch);
    await expect(call()).rejects.toMatchObject({ code: "schema_mismatch" });
  });
});

describe("fetchTemplates list shape", () => {
  it("treats null body as empty array", async () => {
    installFetch(vi.fn(async () => mockJSON(null, { status: 200 })) as typeof fetch);
    const out = await fetchTemplates();
    expect(out).toEqual([]);
  });
});

describe("fetchApprovals query string", () => {
  it("omits status query when not provided", async () => {
    const seen: string[] = [];
    installFetch(
      vi.fn(async (url: RequestInfo | URL) => {
        seen.push(String(url));
        return mockJSON([], { status: 200 });
      }) as typeof fetch,
    );
    await fetchApprovals();
    expect(seen[0]).toMatch(/\/api\/approvals$/);
  });

  it("treats null body as empty array", async () => {
    installFetch(vi.fn(async () => mockJSON(null, { status: 200 })) as typeof fetch);
    const out = await fetchApprovals();
    expect(out).toEqual([]);
  });
});
