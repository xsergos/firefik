import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  deleteAgent,
  fetchAgents,
  fetchAgentTokens,
  revokeAgentToken,
  type FleetAgent,
} from "@/lib/fleetApi";
import { queryKeys } from "@/lib/queryKeys";
import { ageSeconds, formatRelative } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableLoading, TableError } from "@/components/shared/TableStates";
import { AgentStatusBadge } from "@/components/shared/AgentStatusBadge";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { useContainers } from "@/hooks/useContainers";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "healthy" | "stale" | "dead" | "unknown";

const STATUS_FILTERS: StatusFilter[] = ["all", "healthy", "stale", "dead", "unknown"];
const STATUS_ORDER: Record<string, number> = { dead: 0, stale: 1, unknown: 2, healthy: 3 };
const LONG_OFFLINE_SEC = 86400;

function isRemovable(agent: FleetAgent): boolean {
  return agent.status !== "healthy";
}

function isStatusFilter(v: string | null): v is StatusFilter {
  return v !== null && (STATUS_FILTERS as string[]).includes(v);
}

type ContainerCounts = { total: number; protected: number };

export default function FleetPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const statusParam = params.get("status");
  const status: StatusFilter = isStatusFilter(statusParam) ? statusParam : "all";
  const setStatus = (next: StatusFilter) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next === "all") out.delete("status");
        else out.set("status", next);
        return out;
      },
      { replace: true },
    );
  const [search, setSearch] = useState("");
  const [version, setVersion] = useState("");
  const [removeTarget, setRemoveTarget] = useState<FleetAgent | null>(null);
  const [revokeToken, setRevokeToken] = useState(true);

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: queryKeys.agents(),
    queryFn: fetchAgents,
    refetchInterval: 10_000,
  });

  const tokensQuery = useQuery({
    queryKey: ["agent-tokens", false] as const,
    queryFn: () => fetchAgentTokens(false),
    enabled: removeTarget !== null,
  });
  const targetToken = removeTarget
    ? (tokensQuery.data ?? []).find((t) => t.name === removeTarget.instance_id && !t.revoked_at)
    : undefined;

  const remove = useMutation({
    mutationFn: async (agent: FleetAgent) => {
      await deleteAgent(agent.instance_id);
      if (revokeToken && targetToken) {
        await revokeAgentToken(targetToken.id);
      }
    },
    onSuccess: (_, agent) => {
      qc.invalidateQueries({ queryKey: queryKeys.agents() });
      qc.invalidateQueries({ queryKey: ["agent-tokens"] });
      setRemoveTarget(null);
      toast.success(`Agent ${agent.instance_id} removed`);
    },
    onError: (e: Error) => toast.error(`Remove failed: ${e.message}`),
  });

  const agents = useMemo(() => data ?? [], [data]);
  const containers = useContainers();
  const containerCounts = useMemo(() => {
    const out = new Map<string, ContainerCounts>();
    for (const c of containers.data ?? []) {
      if (!c.agent_id) continue;
      const cur = out.get(c.agent_id) ?? { total: 0, protected: 0 };
      cur.total += 1;
      if (c.firewallStatus === "active") cur.protected += 1;
      out.set(c.agent_id, cur);
    }
    return out;
  }, [containers.data]);
  const countsKnown = containers.isSuccess;

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: agents.length,
      healthy: 0,
      stale: 0,
      dead: 0,
      unknown: 0,
    };
    for (const a of agents) c[a.status] += 1;
    return c;
  }, [agents]);

  const versions = useMemo(
    () =>
      Array.from(new Set(agents.map((a) => a.version).filter(Boolean)))
        .sort()
        .reverse(),
    [agents],
  );

  const longOffline = useMemo(
    () =>
      agents.filter((a) => a.status !== "healthy" && ageSeconds(a.last_seen) > LONG_OFFLINE_SEC),
    [agents],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return agents
      .filter((a) => status === "all" || a.status === status)
      .filter((a) => !version || a.version === version)
      .filter(
        (a) =>
          !needle ||
          a.instance_id.toLowerCase().includes(needle) ||
          a.hostname.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
          a.instance_id.localeCompare(b.instance_id),
      );
  }, [agents, status, version, search]);

  return (
    <div className="space-y-4" aria-busy={isFetching}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Fleet</h1>
        <Button asChild size="sm">
          <Link to="/fleet/add">+ Add agent</Link>
        </Button>
      </div>

      {longOffline.length > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
        >
          <span>
            {longOffline.length === 1 ? "1 agent has" : `${longOffline.length} agents have`} been
            offline for more than 24 h:{" "}
            {longOffline.map((a, i) => (
              <span key={a.instance_id}>
                {i > 0 && ", "}
                <strong className="font-mono">{a.instance_id}</strong> (
                {formatRelative(a.last_seen).replace(" ago", "")})
              </span>
            ))}
          </span>
          <Button size="sm" variant="outline" onClick={() => setStatus("dead")}>
            Review
          </Button>
        </div>
      )}

      {isLoading ? (
        <TableLoading label="Loading agents…" />
      ) : isError ? (
        <TableError label="Could not connect to control plane." />
      ) : agents.length === 0 ? (
        <EmptyState title="No agents registered yet." helpAnchor="add-host">
          <p>Add your first host to start protecting its containers.</p>
          <Button asChild size="sm" className="mt-2">
            <Link to="/fleet/add">Add agent</Link>
          </Button>
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="fleet-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search instance or hostname"
              aria-label="Search agents"
              className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm w-64 max-w-full"
            />
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
              {STATUS_FILTERS.filter((s) => s === "all" || counts[s] > 0 || s === status).map(
                (s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={status === s}
                    onClick={() => setStatus(s)}
                    className={cn(
                      "rounded-full border px-3 py-0.5 text-xs capitalize",
                      status === s
                        ? "bg-primary text-primary-foreground border-primary"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {s} <span className="opacity-70 tabular-nums">{counts[s]}</span>
                  </button>
                ),
              )}
            </div>
            {versions.length > 1 && (
              <select
                id="fleet-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                aria-label="Filter by version"
                className="border border-input bg-background text-foreground px-2 py-1 rounded text-sm"
              >
                <option value="">Any version</option>
                {versions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents match the current filters.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Instance</TableHead>
                  <TableHead>Hostname</TableHead>
                  <TableHead>Backend</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Containers</TableHead>
                  <TableHead className="text-right">Protected</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((agent) => (
                  <TableRow key={agent.instance_id}>
                    <TableCell className="font-mono">
                      <Link
                        to={`/fleet/${encodeURIComponent(agent.instance_id)}`}
                        className="underline"
                      >
                        {agent.instance_id}
                      </Link>
                    </TableCell>
                    <TableCell>{agent.hostname}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{agent.backend || "?"}</Badge>
                    </TableCell>
                    <TableCell>
                      <AgentStatusBadge status={agent.status} />
                    </TableCell>
                    <TableCell title={new Date(agent.last_seen).toLocaleString()}>
                      {formatRelative(agent.last_seen)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{agent.version}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {countsKnown ? (containerCounts.get(agent.instance_id)?.total ?? 0) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {countsKnown ? (containerCounts.get(agent.instance_id)?.protected ?? 0) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {isRemovable(agent) ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setRevokeToken(true);
                            setRemoveTarget(agent);
                          }}
                        >
                          Remove
                        </Button>
                      ) : (
                        <span title="Stop the agent first" className="inline-block">
                          <Button size="sm" variant="destructive" disabled>
                            Remove
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={`Remove agent ${removeTarget?.instance_id ?? ""}?`}
        description="Removes the agent, its snapshots and pending commands from the control plane. Audit history stays. If the host comes back online it registers again."
        confirmLabel="Remove agent"
        pending={remove.isPending}
        onConfirm={() => removeTarget && remove.mutate(removeTarget)}
      >
        {targetToken && (
          <label className="flex items-center gap-2 text-sm">
            <input
              id="fleet-remove-revoke"
              type="checkbox"
              checked={revokeToken}
              onChange={(e) => setRevokeToken(e.target.checked)}
            />
            Also revoke its agent token <code className="text-xs">{targetToken.name}</code>
          </label>
        )}
      </ConfirmDialog>
    </div>
  );
}
