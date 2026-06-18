import { z } from "zod";

const agentSchema = z.object({
  instance_id: z.string(),
  hostname: z.string(),
  version: z.string(),
  backend: z.string(),
  chain: z.string(),
  labels: z.record(z.string(), z.string()).optional(),
  first_seen: z.string(),
  last_seen: z.string(),
  event_count: z.number(),
  has_snapshot: z.boolean(),
  status: z.enum(["healthy", "stale", "dead", "unknown"]),
});

const containerStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  firewall_status: z.string(),
  default_policy: z.string(),
  labels: z.record(z.string(), z.string()).optional(),
  rule_set_count: z.number(),
  sources: z.array(z.string()).optional(),
});

const snapshotSchema = z.object({
  agent: z.object({
    instance_id: z.string(),
    hostname: z.string(),
    version: z.string(),
    backend: z.string(),
    chain: z.string(),
    labels: z.record(z.string(), z.string()).optional(),
  }),
  containers: z
    .array(containerStateSchema)
    .nullable()
    .transform((v) => v ?? []),
  at: z.string(),
});

const agentDetailSchema = z.object({
  agent: agentSchema,
  snapshot: snapshotSchema.nullable().optional(),
});

const commandResponseSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  action: z.string(),
});

export type FleetAgent = z.infer<typeof agentSchema>;
export type FleetSnapshot = z.infer<typeof snapshotSchema>;
export type FleetAgentDetail = z.infer<typeof agentDetailSchema>;
export type FleetCommandResponse = z.infer<typeof commandResponseSchema>;
export type FleetCommandAction = "apply" | "disable" | "reconcile" | "token_rotate";

class FleetAPIError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJSON<T>(path: string, schema: z.ZodSchema<T>): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) {
    const text = await res.text();
    throw new FleetAPIError(res.status, text || `${res.status}`);
  }
  return schema.parse(await res.json());
}

async function postJSON<T>(path: string, body: unknown, schema: z.ZodSchema<T>): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new FleetAPIError(res.status, text || `${res.status}`);
  }
  return schema.parse(await res.json());
}

export function fetchAgents(): Promise<FleetAgent[]> {
  return getJSON(
    "/api/agents",
    z
      .array(agentSchema)
      .nullable()
      .transform((v) => v ?? []),
  );
}

export function fetchAgent(id: string): Promise<FleetAgentDetail> {
  return getJSON(`/api/agents/${encodeURIComponent(id)}`, agentDetailSchema);
}

export function fetchAgentSnapshot(id: string): Promise<FleetAgentDetail> {
  return getJSON(`/api/agents/${encodeURIComponent(id)}/snapshot`, agentDetailSchema);
}

export function sendAgentCommand(
  id: string,
  action: FleetCommandAction,
  containerID?: string,
): Promise<FleetCommandResponse> {
  return postJSON(
    `/api/agents/${encodeURIComponent(id)}/commands`,
    { action, container_id: containerID },
    commandResponseSchema,
  );
}

const enrollmentTokenSchema = z.object({
  token: z.string(),
  agent_id: z.string(),
  expires_at: z.string(),
  issued_at: z.string(),
});

export type EnrollmentToken = z.infer<typeof enrollmentTokenSchema>;

export function createEnrollmentToken(
  agentID: string,
  ttlSeconds?: number,
): Promise<EnrollmentToken> {
  return postJSON(
    "/api/enrollment-tokens",
    { agent_id: agentID, ttl_seconds: ttlSeconds },
    enrollmentTokenSchema,
  );
}

const fleetStatsSchema = z.object({
  agents: z.object({
    total: z.number(),
    healthy: z.number(),
    stale: z.number(),
    dead: z.number(),
    unknown: z.number(),
  }),
  containers: z.object({
    total: z.number(),
    running: z.number(),
    enabled: z.number(),
  }),
  traffic: z
    .array(
      z.object({
        ts: z.string(),
        accepted: z.number(),
        dropped: z.number(),
      }),
    )
    .nullable()
    .transform((v) => v ?? []),
});

export type FleetStats = z.infer<typeof fleetStatsSchema>;

export function fetchFleetStats(): Promise<FleetStats> {
  return getJSON("/api/stats", fleetStatsSchema);
}

const agentLiveStatsSchema = z.object({
  containers: z
    .object({
      total: z.number(),
      running: z.number(),
      enabled: z.number(),
    })
    .optional(),
  traffic: z
    .array(
      z.object({
        ts: z.string(),
        accepted: z.number(),
        dropped: z.number(),
      }),
    )
    .optional(),
  rules_active_containers: z.number().optional(),
  at: z.string().optional(),
});

export type AgentLiveStats = z.infer<typeof agentLiveStatsSchema>;

export function fetchAgentStats(id: string): Promise<AgentLiveStats> {
  return getJSON(`/api/agents/${encodeURIComponent(id)}/stats`, agentLiveStatsSchema);
}

const agentTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional().default(""),
  issued_by: z.string(),
  issued_at: z.string(),
  last_used_at: z.string().nullable().optional(),
  last_used_ip: z.string().optional().default(""),
  revoked_at: z.string().nullable().optional(),
});

const agentTokenIssuedSchema = agentTokenSchema.extend({
  token: z.string(),
});

export type AgentTokenRecord = z.infer<typeof agentTokenSchema>;
export type AgentTokenIssued = z.infer<typeof agentTokenIssuedSchema>;

export function fetchAgentTokens(includeRevoked = false): Promise<AgentTokenRecord[]> {
  const qs = includeRevoked ? "?include_revoked=1" : "";
  return getJSON(
    `/api/agent-tokens${qs}`,
    z
      .array(agentTokenSchema)
      .nullable()
      .transform((v) => v ?? []),
  );
}

export function createAgentToken(name: string, description?: string): Promise<AgentTokenIssued> {
  return postJSON(`/api/agent-tokens`, { name, description }, agentTokenIssuedSchema);
}

export async function revokeAgentToken(id: string): Promise<void> {
  const res = await fetch(`/api/agent-tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new FleetAPIError(res.status, text || `${res.status}`);
  }
}

const whoamiSchema = z.object({
  username: z.string().optional().default(""),
  auth_kind: z.enum(["session", "bearer", "none"]),
});

const loginResponseSchema = z.object({
  username: z.string(),
  expires_at: z.string(),
});

export type Whoami = z.infer<typeof whoamiSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export async function whoami(): Promise<Whoami | null> {
  const res = await fetch("/api/whoami", { credentials: "same-origin" });
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) {
    throw new FleetAPIError(res.status, await res.text());
  }
  return whoamiSchema.parse(await res.json());
}

export function login(username: string, password: string): Promise<LoginResponse> {
  return postJSON("/api/login", { username, password }, loginResponseSchema);
}

export async function logout(): Promise<void> {
  const res = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  if (!res.ok && res.status !== 204) {
    throw new FleetAPIError(res.status, await res.text());
  }
}
