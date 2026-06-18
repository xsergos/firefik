import { z } from "zod";
import { APIError } from "@/lib/api";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export const policyTemplateSchema = z.object({
  name: z.string(),
  version: z.number(),
  body: z.string(),
  labels: z.record(z.string(), z.string()).optional().nullable(),
  publisher: z.string().optional().default(""),
  created_at: z.string(),
  updated_at: z.string(),
});

export type PolicyTemplate = z.infer<typeof policyTemplateSchema>;

export const pendingApprovalSchema = z.object({
  id: z.string(),
  policy_name: z.string(),
  proposed_body: z.string(),
  requester: z.string(),
  requester_fingerprint: z.string(),
  requested_at: z.string(),
  approver: z.string().optional().default(""),
  approver_fingerprint: z.string().optional().default(""),
  approved_at: z.string().optional().nullable(),
  status: z.enum(["pending", "approved", "rejected"]),
  rejection_comment: z.string().optional().default(""),
});

export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

async function getJSON<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new APIError(res.status, "request_failed", `${res.status} ${res.statusText}`);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new APIError(res.status, "schema_mismatch", "unexpected response");
  return parsed.data;
}

async function postJSON<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new APIError(res.status, "request_failed", text || `${res.status}`);
  }
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new APIError(res.status, "schema_mismatch", "unexpected response");
  return parsed.data;
}

export function fetchTemplates(): Promise<PolicyTemplate[]> {
  return getJSON(
    "/api/templates",
    z
      .array(policyTemplateSchema)
      .nullable()
      .transform((v) => v ?? []),
  );
}

export function fetchTemplate(name: string): Promise<PolicyTemplate> {
  return getJSON(`/api/templates/${encodeURIComponent(name)}`, policyTemplateSchema);
}

export function publishTemplate(t: {
  name: string;
  body: string;
  labels?: Record<string, string>;
}): Promise<PolicyTemplate> {
  return postJSON("/api/templates", t, policyTemplateSchema);
}

export function fetchApprovals(status?: string): Promise<PendingApproval[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return getJSON(
    `/api/approvals${qs}`,
    z
      .array(pendingApprovalSchema)
      .nullable()
      .transform((v) => v ?? []),
  );
}

export function createApproval(p: {
  policy_name: string;
  proposed_body: string;
  requester: string;
}): Promise<PendingApproval> {
  return postJSON("/api/approvals", p, pendingApprovalSchema);
}

export function approveApproval(id: string, approver: string): Promise<PendingApproval> {
  return postJSON(
    `/api/approvals/${encodeURIComponent(id)}/approve`,
    { approver },
    pendingApprovalSchema,
  );
}

export function rejectApproval(
  id: string,
  approver: string,
  comment: string,
): Promise<PendingApproval> {
  return postJSON(
    `/api/approvals/${encodeURIComponent(id)}/reject`,
    { approver, comment },
    pendingApprovalSchema,
  );
}
