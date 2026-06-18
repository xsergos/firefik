import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import {
  fetchAgentSnapshot,
  fetchAgentStats,
  sendAgentCommand,
  type FleetCommandAction,
} from "@/lib/fleetApi";
import { AgentLogsPanel } from "@/pages/AgentLogsPanel";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableLoading, TableError } from "@/components/shared/TableStates";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  healthy: "default",
  stale: "secondary",
  dead: "destructive",
  unknown: "outline",
};

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const qc = useQueryClient();
  const [pendingAction, setPendingAction] = useState<{
    action: FleetCommandAction;
    container?: string;
  } | null>(null);

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: queryKeys.agentSnapshot(id),
    queryFn: () => fetchAgentSnapshot(id),
    enabled: id !== "",
    refetchInterval: 10_000,
  });

  const command = useMutation({
    mutationFn: ({ action, container }: { action: FleetCommandAction; container?: string }) =>
      sendAgentCommand(id, action, container),
    onSuccess: (_resp, vars) => {
      toast.success(`Command "${vars.action}" enqueued`);
      qc.invalidateQueries({ queryKey: queryKeys.agentSnapshot(id) });
    },
    onError: (e: Error, vars) => toast.error(`${vars.action} failed: ${e.message}`),
    onSettled: () => setPendingAction(null),
  });

  const dispatch = (action: FleetCommandAction, container?: string) => {
    setPendingAction({ action, container });
    command.mutate({ action, container });
  };

  return (
    <div className="space-y-4" aria-busy={isFetching}>
      <div className="flex items-center gap-3">
        <Link to="/fleet" className="text-sm text-muted-foreground underline">
          ← Fleet
        </Link>
        <h1 className="text-2xl font-bold font-mono">{id}</h1>
        {data?.agent && (
          <Badge variant={STATUS_VARIANT[data.agent.status] ?? "outline"}>
            {data.agent.status}
          </Badge>
        )}
      </div>

      {isLoading ? (
        <TableLoading label="Loading agent…" />
      ) : isError ? (
        <TableError label="Could not load agent." />
      ) : data?.agent ? (
        <>
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <Field label="Hostname" value={data.agent.hostname} />
            <Field label="Backend" value={data.agent.backend} />
            <Field label="Chain" value={data.agent.chain} />
            <Field label="Version" value={data.agent.version} />
            <Field label="First seen" value={new Date(data.agent.first_seen).toLocaleString()} />
            <Field label="Last seen" value={new Date(data.agent.last_seen).toLocaleString()} />
            <Field label="Events" value={String(data.agent.event_count)} />
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={command.isPending}
              onClick={() => dispatch("reconcile")}
            >
              Reconcile
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={command.isPending}
              onClick={() => dispatch("token_rotate")}
            >
              Rotate token
            </Button>
          </div>

          <div>
            <h2 className="text-lg font-semibold pt-4 pb-2">Containers</h2>
            {!data.snapshot || data.snapshot.containers.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No snapshot yet — agent has not reported containers.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Container</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Firewall</TableHead>
                    <TableHead>Default policy</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Rule sets</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.snapshot.containers.map((c) => {
                    const busy = command.isPending && pendingAction?.container === c.id;
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono">
                          <div>{c.name}</div>
                          <div className="text-xs text-muted-foreground">{c.id.slice(0, 12)}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{c.status}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={c.firewall_status === "active" ? "default" : "secondary"}>
                            {c.firewall_status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={c.default_policy === "DROP" ? "destructive" : "secondary"}
                          >
                            {c.default_policy}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {(c.sources ?? []).map((s) => (
                              <Badge key={s} variant="outline" className="text-xs">
                                {s}
                              </Badge>
                            ))}
                            {(!c.sources || c.sources.length === 0) && (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{c.rule_set_count}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => dispatch("apply", c.id)}
                            >
                              Apply
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => dispatch("disable", c.id)}
                            >
                              Disable
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          <div>
            <h2 className="text-lg font-semibold pt-4 pb-2">Live stats</h2>
            <AgentLiveStats agentID={id} />
          </div>

          <div>
            <h2 className="text-lg font-semibold pt-4 pb-2">Live logs</h2>
            <AgentLogsPanel agentID={id} />
          </div>
        </>
      ) : (
        <p className="text-muted-foreground">Agent not found.</p>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-sm">{value || "—"}</div>
    </div>
  );
}

function AgentLiveStats({ agentID }: { agentID: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["agent-live-stats", agentID],
    queryFn: () => fetchAgentStats(agentID),
    enabled: agentID !== "",
    refetchInterval: 10_000,
    retry: false,
  });
  if (isLoading) return <p className="text-muted-foreground text-sm">Pulling stats…</p>;
  if (isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Stats pull timed out — agent must be online and reachable on the gRPC stream.
      </p>
    );
  }
  const c = data?.containers ?? { total: 0, running: 0, enabled: 0 };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
      <Field label="Containers (total)" value={String(c.total)} />
      <Field label="Running" value={String(c.running)} />
      <Field label="Firewall enabled" value={String(c.enabled)} />
      {data?.at && (
        <div className="col-span-full text-xs text-muted-foreground">
          Pulled at {new Date(data.at).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
