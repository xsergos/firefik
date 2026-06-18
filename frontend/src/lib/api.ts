import type { z } from "zod";
import { isPanelMode } from "@/lib/panelMode";
import {
  apiErrorSchema,
  auditHistoryListSchema,
  autogenApproveResponseSchema,
  autogenProposalListSchema,
  bulkResponseSchema,
  containerListSchema,
  policyDetailSchema,
  policySimulateResponseSchema,
  policySummaryListSchema,
  policyValidateResponseSchema,
  ruleEntryListSchema,
  statsResponseSchema,
  type AuditHistoryEvent,
  type AutogenApproveResponse,
  type AutogenProposal,
  type BulkAction,
  type BulkResponse,
  type ContainerDTO,
  type PolicyDetail,
  type PolicySimulateResponse,
  type PolicySummary,
  type PolicyValidateResponse,
  type RuleEntry,
  type StatsResponse,
} from "@/types/api";

export type { AuditHistoryEvent };

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const DEFAULT_TIMEOUT_MS = 15_000;

export class APIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly userMessage: string;
  readonly details?: string;

  constructor(status: number, code: string, userMessage: string, details?: string) {
    super(`[${status}] ${code}: ${userMessage}`);
    this.name = "APIError";
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
    this.details = details;
  }
}

const USER_MESSAGES: Record<string, string> = {
  invalid_id: "Invalid container identifier.",
  container_not_found: "Container not found.",
  ambiguous_container_prefix: "Container prefix matches more than one container.",
  docker_unavailable: "Docker daemon is unavailable. Please retry shortly.",
  apply_failed: "Failed to apply firewall rules.",
  disable_failed: "Failed to disable firewall rules.",
  internal_error: "An unexpected error occurred.",
};

const GENERIC_ERROR = "An unexpected error occurred.";

function userMessageFor(code: string, fallback?: string): string {
  return USER_MESSAGES[code] ?? fallback ?? GENERIC_ERROR;
}

interface RequestOptions {
  method?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  opts: RequestOptions = {},
): Promise<T> {
  const { method = "GET", signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  const timeoutController = new AbortController();
  const timeoutID = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = signal
    ? anySignal([signal, timeoutController.signal])
    : timeoutController.signal;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      signal: combinedSignal,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    clearTimeout(timeoutID);
    if (err instanceof DOMException && err.name === "AbortError" && !signal?.aborted) {
      throw new APIError(0, "timeout", "The request took too long.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutID);
  }

  if (!res.ok) {
    const parsed = await res
      .json()
      .then((body) => apiErrorSchema.safeParse(body))
      .catch(() => null);
    if (parsed && parsed.success) {
      const msg = userMessageFor(parsed.data.code, parsed.data.message);
      throw new APIError(res.status, parsed.data.code, msg, parsed.data.details);
    }
    throw new APIError(res.status, "internal_error", GENERIC_ERROR);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const body: unknown = await res.json();
  const result = schema.safeParse(body);
  if (!result.success) {
    console.error("API response schema mismatch", { path, issues: result.error.issues });
    throw new APIError(res.status, "schema_mismatch", "Server returned an unexpected payload.");
  }
  return result.data;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      return ctrl.signal;
    }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

export function fetchContainers(opts: { signal?: AbortSignal } = {}): Promise<ContainerDTO[]> {
  return request("/api/containers", containerListSchema, opts);
}

export function fetchStats(opts: { signal?: AbortSignal } = {}): Promise<StatsResponse> {
  return request("/api/stats", statsResponseSchema, opts);
}

export function fetchRules(opts: { signal?: AbortSignal } = {}): Promise<RuleEntry[]> {
  return request("/api/rules", ruleEntryListSchema, opts);
}

export function fetchAuditHistory(
  limit?: number,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditHistoryEvent[]> {
  const q = limit ? `?limit=${limit}` : "";
  return request(`/api/audit/history${q}`, auditHistoryListSchema, opts);
}

export function wsLogsUrl(filter?: string): string {
  let base: string;
  if (BASE_URL && /^https?:\/\//.test(BASE_URL)) {
    base = BASE_URL.replace(/^http/, "ws");
  } else {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    base = `${proto}//${location.host}`;
  }
  const path = isPanelMode ? "/api/logs" : "/ws/logs";
  if (filter) return `${base}${path}?filter=${encodeURIComponent(filter)}`;
  return `${base}${path}`;
}

export async function applyContainerRules(id: string, agentID?: string): Promise<void> {
  await rawPOST(`/api/containers/${id}/apply`, agentID ? { agent_id: agentID } : undefined);
}

export async function deactivateContainerRules(id: string, agentID?: string): Promise<void> {
  await rawPOST(`/api/containers/${id}/disable`, agentID ? { agent_id: agentID } : undefined);
}

export async function bulkContainerActions(
  actions: (BulkAction & { agent_id?: string })[],
): Promise<BulkResponse> {
  const res = await fetch(`${BASE_URL}/api/containers/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ actions }),
  });
  if (!res.ok) {
    const parsed = await res
      .json()
      .then((b) => apiErrorSchema.safeParse(b))
      .catch(() => null);
    if (parsed && parsed.success) {
      const msg = userMessageFor(parsed.data.code, parsed.data.message);
      throw new APIError(res.status, parsed.data.code, msg, parsed.data.details);
    }
    throw new APIError(res.status, "internal_error", GENERIC_ERROR);
  }
  const body: unknown = await res.json();
  const out = bulkResponseSchema.safeParse(body);
  if (!out.success) {
    throw new APIError(
      res.status,
      "schema_mismatch",
      "Server returned an unexpected bulk payload.",
    );
  }
  return out.data;
}

export function fetchPolicies(opts: { signal?: AbortSignal } = {}): Promise<PolicySummary[]> {
  return request("/api/policies", policySummaryListSchema, opts);
}

export function fetchPolicy(
  name: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PolicyDetail> {
  return request(`/api/policies/${encodeURIComponent(name)}`, policyDetailSchema, opts);
}

export async function validatePolicy(dsl: string): Promise<PolicyValidateResponse> {
  const res = await fetch(`${BASE_URL}/api/policies/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ dsl }),
  });
  if (!res.ok) {
    const parsed = await res
      .json()
      .then((b) => apiErrorSchema.safeParse(b))
      .catch(() => null);
    if (parsed && parsed.success) {
      throw new APIError(
        res.status,
        parsed.data.code,
        userMessageFor(parsed.data.code, parsed.data.message),
        parsed.data.details,
      );
    }
    throw new APIError(res.status, "internal_error", GENERIC_ERROR);
  }
  const body: unknown = await res.json();
  const out = policyValidateResponseSchema.safeParse(body);
  if (!out.success)
    throw new APIError(res.status, "schema_mismatch", "Unexpected validate response");
  return out.data;
}

export async function simulatePolicy(
  name: string,
  opts: { containerID?: string; dsl?: string; labels?: Record<string, string> },
): Promise<PolicySimulateResponse> {
  const res = await fetch(`${BASE_URL}/api/policies/${encodeURIComponent(name)}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const parsed = await res
      .json()
      .then((b) => apiErrorSchema.safeParse(b))
      .catch(() => null);
    if (parsed && parsed.success) {
      throw new APIError(
        res.status,
        parsed.data.code,
        userMessageFor(parsed.data.code, parsed.data.message),
        parsed.data.details,
      );
    }
    throw new APIError(res.status, "internal_error", GENERIC_ERROR);
  }
  const body: unknown = await res.json();
  const out = policySimulateResponseSchema.safeParse(body);
  if (!out.success)
    throw new APIError(res.status, "schema_mismatch", "Unexpected simulate response");
  return out.data;
}

export async function savePolicy(
  name: string,
  dsl: string,
  comment?: string,
): Promise<PolicySummary> {
  const res = await fetch(`${BASE_URL}/api/policies/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ dsl, comment: comment ?? "" }),
  });
  if (!res.ok) {
    const parsed = await res
      .json()
      .then((b) => apiErrorSchema.safeParse(b))
      .catch(() => null);
    if (parsed && parsed.success) {
      throw new APIError(
        res.status,
        parsed.data.code,
        userMessageFor(parsed.data.code, parsed.data.message),
        parsed.data.details,
      );
    }
    throw new APIError(res.status, "internal_error", GENERIC_ERROR);
  }
  const body: unknown = await res.json();
  return body as PolicySummary;
}

export function fetchAutogenProposals(
  opts: { signal?: AbortSignal } = {},
): Promise<AutogenProposal[]> {
  return request("/api/autogen/proposals", autogenProposalListSchema, opts);
}

export async function approveAutogen(
  containerID: string,
  mode: "labels" | "policy",
  agentID?: string,
): Promise<AutogenApproveResponse> {
  const reqBody: Record<string, unknown> = { mode };
  if (agentID) reqBody.agent_id = agentID;
  const res = await fetch(
    `${BASE_URL}/api/autogen/proposals/${encodeURIComponent(containerID)}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(reqBody),
    },
  );
  if (!res.ok) {
    const parsed = await res
      .json()
      .then((b) => apiErrorSchema.safeParse(b))
      .catch(() => null);
    if (parsed && parsed.success) {
      throw new APIError(
        res.status,
        parsed.data.code,
        userMessageFor(parsed.data.code, parsed.data.message),
        parsed.data.details,
      );
    }
    throw new APIError(res.status, "internal_error", GENERIC_ERROR);
  }
  const body: unknown = await res.json();
  const out = autogenApproveResponseSchema.safeParse(body);
  if (!out.success)
    throw new APIError(res.status, "schema_mismatch", "Unexpected approve response");
  return out.data;
}

export async function rejectAutogen(
  containerID: string,
  reason?: string,
  agentID?: string,
): Promise<void> {
  const reqBody: Record<string, unknown> = { reason: reason ?? "" };
  if (agentID) reqBody.agent_id = agentID;
  const res = await fetch(
    `${BASE_URL}/api/autogen/proposals/${encodeURIComponent(containerID)}/reject`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(reqBody),
    },
  );
  if (!res.ok) {
    const parsed = await res
      .json()
      .then((b) => apiErrorSchema.safeParse(b))
      .catch(() => null);
    if (parsed && parsed.success) {
      throw new APIError(
        res.status,
        parsed.data.code,
        userMessageFor(parsed.data.code, parsed.data.message),
        parsed.data.details,
      );
    }
    throw new APIError(res.status, "internal_error", GENERIC_ERROR);
  }
}

async function rawPOST(path: string, body?: unknown): Promise<void> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok) {
    const parsed = await res
      .json()
      .then((b) => apiErrorSchema.safeParse(b))
      .catch(() => null);
    if (parsed && parsed.success) {
      const msg = userMessageFor(parsed.data.code, parsed.data.message);
      throw new APIError(res.status, parsed.data.code, msg, parsed.data.details);
    }
    throw new APIError(res.status, "internal_error", GENERIC_ERROR);
  }
}
