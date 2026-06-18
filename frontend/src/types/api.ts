import { z } from "zod";

export const rateLimitSchema = z.object({
  rate: z.number().nonnegative(),
  burst: z.number().nonnegative(),
});

export const firewallRuleSetSchema = z.object({
  name: z.string(),
  ports: z.array(z.number().int().min(0).max(65535)).default([]),
  allowlist: z.array(z.string()).default([]),
  blocklist: z.array(z.string()).default([]),
  profile: z.string().optional(),
  protocol: z.string().optional(),
  log: z.boolean().optional(),
  logPrefix: z.string().optional(),
  rateLimit: rateLimitSchema.optional(),
  geoBlock: z.array(z.string()).optional(),
  geoAllow: z.array(z.string()).optional(),
});

export const firewallStatusSchema = z.enum(["disabled", "active", "inactive"]);
export const defaultPolicySchema = z.enum(["DROP", "ACCEPT", "RETURN"]);

export const containerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: z.string(),
  enabled: z.boolean(),
  firewallStatus: firewallStatusSchema,
  labels: z.record(z.string(), z.string()).default({}),
  defaultPolicy: defaultPolicySchema.optional(),
  ruleSets: z.array(firewallRuleSetSchema).optional(),
  agent_id: z.string().optional(),
  agent_hostname: z.string().optional(),
  rule_set_count: z.number().optional(),
});

export const containerListSchema = z
  .array(containerSchema)
  .nullable()
  .transform((v) => v ?? []);

export const logEntrySchema = z.object({
  ts: z.string(),
  raw: z.string().optional().default(""),
  action: z.enum(["ACCEPT", "DROP"]).optional(),
  srcIP: z.string().optional(),
  dstPort: z.number().optional(),
  container: z.string().optional(),
  containerID: z.string().optional(),
  containerName: z.string().optional(),
  proto: z.string().optional(),
});

export const logStreamMessageSchema = z.union([
  z.object({ event: z.literal("dropped"), count: z.number() }),
  z.object({ event: z.literal("server_shutdown") }),
  logEntrySchema,
]);

export const ruleEntrySchema = z.object({
  containerID: z.string(),
  containerName: z.string(),
  status: z.string(),
  defaultPolicy: defaultPolicySchema,
  ruleSets: z.array(firewallRuleSetSchema),
  agent_id: z.string().optional(),
  agent_hostname: z.string().optional(),
  rule_set_count: z.number().optional(),
});

export const ruleEntryListSchema = z
  .array(ruleEntrySchema)
  .nullable()
  .transform((v) => v ?? []);

export const statsResponseSchema = z.object({
  containers: z.object({
    total: z.number(),
    running: z.number(),
    enabled: z.number(),
  }),
  traffic: z.array(
    z.object({
      ts: z.string(),
      accepted: z.number(),
      dropped: z.number(),
    }),
  ),
});

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.string().optional(),
});

export type RateLimitDTO = z.infer<typeof rateLimitSchema>;
export type FirewallRuleSetDTO = z.infer<typeof firewallRuleSetSchema>;
export type ContainerDTO = z.infer<typeof containerSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type LogStreamMessage = z.infer<typeof logStreamMessageSchema>;
export type RuleEntry = z.infer<typeof ruleEntrySchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type APIErrorResponse = z.infer<typeof apiErrorSchema>;

export const bulkActionSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["apply", "disable"]),
});

export const bulkResultItemSchema = z.object({
  id: z.string(),
  action: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
});

export const bulkResponseSchema = z.object({
  results: z.array(bulkResultItemSchema),
  summary: z.object({
    total: z.number(),
    applied: z.number(),
    disabled: z.number(),
    failed: z.number(),
  }),
});

export type BulkAction = z.infer<typeof bulkActionSchema>;
export type BulkResultItem = z.infer<typeof bulkResultItemSchema>;
export type BulkResponse = z.infer<typeof bulkResponseSchema>;

export const policySummarySchema = z.object({
  name: z.string(),
  version: z.string(),
  source: z.string().optional(),
  rules: z.number(),
  author: z.string().optional(),
  comment: z.string().optional(),
  sha: z.string().optional(),
  committedAt: z.string().optional(),
});
export const policySummaryListSchema = z
  .array(policySummarySchema)
  .nullable()
  .transform((v) => v ?? []);
export type PolicySummary = z.infer<typeof policySummarySchema>;

export const policyDetailSchema = z.object({
  name: z.string(),
  version: z.string(),
  source: z.string().optional(),
  dsl: z.string(),
  ruleSets: z.array(firewallRuleSetSchema),
  author: z.string().optional(),
  comment: z.string().optional(),
  sha: z.string().optional(),
  committedAt: z.string().optional(),
});
export type PolicyDetail = z.infer<typeof policyDetailSchema>;

export const policyValidateResponseSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});
export type PolicyValidateResponse = z.infer<typeof policyValidateResponseSchema>;

export const policySimulateResponseSchema = z.object({
  policy: z.string(),
  container: z.string().optional(),
  defaultPolicy: z.string().optional(),
  ruleSets: z.array(firewallRuleSetSchema),
  warnings: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  labelsSeen: z.record(z.string(), z.string()).optional(),
});
export type PolicySimulateResponse = z.infer<typeof policySimulateResponseSchema>;

export const autogenProposalSchema = z.object({
  container_id: z.string(),
  ports: z.array(z.number().int().min(0).max(65535)).optional(),
  peers: z.array(z.string()).optional(),
  observed_for: z.string().optional(),
  confidence: z.string().optional(),
  status: z.string().optional(),
  decided_by: z.string().optional(),
  decided_at: z.string().optional(),
  reason: z.string().optional(),
  agent_id: z.string().optional(),
  agent_hostname: z.string().optional(),
  updated_at: z.string().optional(),
});
export const autogenProposalListSchema = z
  .array(autogenProposalSchema)
  .nullable()
  .transform((v) => v ?? []);
export type AutogenProposal = z.infer<typeof autogenProposalSchema>;

export const autogenApproveResponseSchema = z.object({
  mode: z.enum(["labels", "policy"]),
  snippet: z.string(),
  container_id: z.string(),
  ports: z.array(z.number()).optional(),
  peers: z.array(z.string()).optional(),
});
export type AutogenApproveResponse = z.infer<typeof autogenApproveResponseSchema>;

export const auditHistoryEventSchema = z.object({
  ts: z.string(),
  action: z.string(),
  source: z.string(),
  container_id: z.string().optional(),
  container_name: z.string().optional(),
  container_ips: z.array(z.string()).optional(),
  rule_sets: z.number().optional(),
  default_policy: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  agent_id: z.string().optional(),
  agent_hostname: z.string().optional(),
});
export const auditHistoryListSchema = z
  .array(auditHistoryEventSchema)
  .nullable()
  .transform((v) => v ?? []);
export type AuditHistoryEvent = z.infer<typeof auditHistoryEventSchema>;
