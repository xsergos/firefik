export const queryKeys = {
  containers: () => ["containers"] as const,
  container: (id: string) => ["containers", id] as const,
  rules: () => ["rules"] as const,
  profiles: () => ["rules", "profiles"] as const,
  stats: () => ["stats"] as const,
  templates: () => ["templates"] as const,
  approvals: (status?: string) =>
    status ? (["approvals", status] as const) : (["approvals"] as const),
  agents: () => ["agents"] as const,
  agent: (id: string) => ["agents", id] as const,
  agentSnapshot: (id: string) => ["agents", id, "snapshot"] as const,
} as const;

export const invalidateAfterMutation = [
  queryKeys.containers(),
  queryKeys.rules(),
  queryKeys.stats(),
] as const;
