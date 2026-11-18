import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Boxes, History, RefreshCw, ScrollText, Trash2 } from "lucide-react";
import {
  deleteAgent,
  fetchAgentSnapshot,
  fetchAgentTokens,
  fetchFlows,
  sendAgentCommand,
  type FleetAgent,
  type FleetCommandAction,
} from "@/lib/fleetApi";
import { AgentLogsPanel } from "@/pages/AgentLogsPanel";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelative } from "@/lib/time";
import {
  IN_FLIGHT_HINT,
  NO_LABELS_HINT,
  UNLISTED_PORTS_HINT,
  canApplyFirewall,
  containerHref,
  containersHref,
  isInFlight,
  trafficHref,
} from "@/lib/firewallState";
import {
  applyToastMessage,
  turnOffToastMessage,
  usePendingFirewall,
} from "@/hooks/useContainerMutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableLoading, TableError } from "@/components/shared/TableStates";
import { AgentStatusBadge } from "@/components/shared/AgentStatusBadge";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { FirewallBadge, UnlistedPortsBadge } from "@/components/shared/FirewallBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

type PendingDisable = { id: string; name: string } | null;

type CommandVars = { action: FleetCommandAction; container?: string; name?: string };

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [pendingContainer, setPendingContainer] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<PendingDisable>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const { data, isLoading, isError, isFetching, dataUpdatedAt } = useQuery({
    queryKey: queryKeys.agentSnapshot(id),
    queryFn: () => fetchAgentSnapshot(id),
    enabled: id !== "",
    refetchInterval: 10_000,
  });
  const pending = usePendingFirewall(dataUpdatedAt, (cid) => {
    const c = data?.snapshot?.containers?.find((x) => x.id === cid);
    if (!c) return undefined;
    return { status: c.firewall_status, name: c.name || c.id.slice(0, 12), agentID: id };
  });

  const command = useMutation({
    mutationFn: ({ action, container }: CommandVars) => sendAgentCommand(id, action, container),
    onSuccess: (_resp, vars) => {
      const name = vars.name ?? vars.container ?? "";
      if (vars.action === "apply") toast.success(applyToastMessage(name, id));
      else if (vars.action === "disable") toast.success(turnOffToastMessage(name, id));
      else if (vars.action === "reconcile")
        toast.success(`Sent to ${id}: re-reading labels and re-applying every container's rules…`);
      else toast.success(`Sent to ${id}: ${vars.action}…`);
      if (vars.container)
        pending.mark([vars.container], vars.action === "disable" ? "off" : "apply");
      qc.invalidateQueries({ queryKey: queryKeys.agentSnapshot(id) });
    },
    onError: (e: Error, vars) => {
      if (vars.container) pending.clear([vars.container]);
      toast.error(`${vars.action} failed: ${e.message}`);
    },
    onSettled: () => setPendingContainer(null),
  });

  const remove = useMutation({
    mutationFn: () => deleteAgent(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents() });
      toast.success(`Agent ${id} removed`);
      navigate("/fleet");
    },
    onError: (e: Error) => toast.error(`Remove failed: ${e.message}`),
  });

  const dispatch = (action: FleetCommandAction, container?: string, name?: string) => {
    setPendingContainer(container ?? null);
    if (container) pending.mark([container], action === "disable" ? "off" : "apply");
    command.mutate({ action, container, name });
  };

  const agent = data?.agent;
  const containers = useMemo(
    () => [...(data?.snapshot?.containers ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [data],
  );
  const snapshotAt = data?.snapshot?.at;

  return (
    <div className="space-y-6" aria-busy={isFetching}>
      <Link
        to="/fleet"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Fleet
      </Link>

      {isLoading ? (
        <TableLoading label="Loading agent…" />
      ) : isError ? (
        <TableError label="Could not load agent." />
      ) : agent ? (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold font-mono break-all">{id}</h1>
                <AgentStatusBadge status={agent.status} />
              </div>
              <p className="text-sm text-muted-foreground">
                {agent.hostname !== id && <span>{agent.hostname} · </span>}
                {agent.version || "unknown version"} · {agent.backend || "?"} · chain{" "}
                {agent.chain || "?"} · last seen{" "}
                <span title={new Date(agent.last_seen).toLocaleString()}>
                  {formatRelative(agent.last_seen)}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={command.isPending}
                onClick={() => dispatch("reconcile")}
                title="Re-read labels and config on the host and re-apply every container's rules"
              >
                <RefreshCw className="mr-1 h-4 w-4" />
                Reconcile
              </Button>
              {agent.status !== "healthy" && (
                <Button variant="destructive" size="sm" onClick={() => setConfirmRemove(true)}>
                  <Trash2 className="mr-1 h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
          </header>

          <AgentTiles agent={agent} containers={containers} snapshotAt={snapshotAt} />

          <nav className="flex flex-wrap gap-2" aria-label="Agent shortcuts">
            <Shortcut to={containersHref(id)} icon={<Boxes />}>
              Containers of this agent
            </Shortcut>
            <Shortcut to={trafficHref(id)} icon={<ScrollText />}>
              Traffic log
            </Shortcut>
            <Shortcut to={`/history?agent=${encodeURIComponent(id)}`} icon={<History />}>
              Change history
            </Shortcut>
          </nav>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Containers</h2>
            {containers.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No snapshot yet — the agent has not reported its containers.
              </p>
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Container</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Firewall</TableHead>
                      <TableHead title={UNLISTED_PORTS_HINT}>Unlisted ports</TableHead>
                      <TableHead>Rules from</TableHead>
                      <TableHead className="text-right">Rule sets</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {containers.map((c) => {
                      const rowPending = pending.pendingFor(c.id, c.firewall_status);
                      const inFlight = isInFlight(rowPending);
                      const busy = (command.isPending && pendingContainer === c.id) || inFlight;
                      const active = c.firewall_status === "active";
                      const applicable = canApplyFirewall(c.firewall_status, c.labels);
                      return (
                        <TableRow key={c.id}>
                          <TableCell>
                            <Link
                              to={containerHref(id, c.name)}
                              className="font-medium underline-offset-4 hover:underline"
                            >
                              {c.name}
                            </Link>
                            <div className="text-xs text-muted-foreground font-mono">
                              {c.id.slice(0, 12)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={c.status === "running" ? "default" : "secondary"}>
                              {c.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <FirewallBadge status={c.firewall_status} pending={rowPending} />
                          </TableCell>
                          <TableCell>
                            {c.default_policy && c.firewall_status !== "disabled" ? (
                              <UnlistedPortsBadge policy={c.default_policy} />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
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
                          <TableCell className="text-right tabular-nums">
                            {c.rule_set_count}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              {applicable ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  aria-label={`${active ? "Re-apply" : "Apply"} rules for ${c.name}`}
                                  title={inFlight ? IN_FLIGHT_HINT : undefined}
                                  disabled={busy}
                                  onClick={() => dispatch("apply", c.id, c.name)}
                                >
                                  {active ? "Re-apply" : "Apply"}
                                </Button>
                              ) : (
                                <span title={NO_LABELS_HINT}>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled
                                    aria-label={`Apply rules for ${c.name}: ${NO_LABELS_HINT}`}
                                  >
                                    Apply
                                  </Button>
                                </span>
                              )}
                              {active && (
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  aria-label={`Turn off firewall for ${c.name}`}
                                  title={inFlight ? IN_FLIGHT_HINT : undefined}
                                  disabled={busy}
                                  onClick={() => setConfirmDisable({ id: c.id, name: c.name })}
                                >
                                  Turn off
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Live traffic</h2>
            <AgentLogsPanel agentID={id} />
          </section>

          <ConfirmDialog
            open={confirmDisable !== null}
            onOpenChange={(open) => {
              if (!open) setConfirmDisable(null);
            }}
            title={`Turn off the firewall for ${confirmDisable?.name ?? ""}?`}
            description="Firefik removes this container's rules and its traffic stops being filtered right away. Press Apply to turn it back on."
            confirmLabel="Turn off"
            onConfirm={() => {
              if (!confirmDisable) return;
              dispatch("disable", confirmDisable.id, confirmDisable.name);
              setConfirmDisable(null);
            }}
          />
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title={`Remove agent ${id}?`}
            description="Removes the agent, its snapshots and pending commands from the control plane. Audit history stays. If the host comes back online it registers again."
            confirmLabel="Remove agent"
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </>
      ) : (
        <p className="text-muted-foreground">Agent not found.</p>
      )}
    </div>
  );
}

function Shortcut({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground"
    >
      {icon}
      {children}
    </Link>
  );
}

function Tile({
  label,
  children,
  hint,
  to,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="block rounded-lg border bg-card p-3 min-w-0 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={hint}
    >
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums truncate">{children}</div>
    </Link>
  );
}

function AgentTiles({
  agent,
  containers,
  snapshotAt,
}: {
  agent: FleetAgent;
  containers: { status: string; firewall_status: string }[];
  snapshotAt?: string;
}) {
  const id = agent.instance_id;
  const drops = useQuery({
    queryKey: ["flows", { since: "24h", agent_id: id, action: "DROP", limit: 1 }],
    queryFn: () => fetchFlows({ since: "24h", agent_id: id, action: "DROP" }),
    refetchInterval: 30_000,
    retry: false,
  });
  const tokens = useQuery({
    queryKey: ["agent-tokens", false] as const,
    queryFn: () => fetchAgentTokens(false),
    retry: false,
  });

  const counts = {
    total: containers.length,
    running: containers.filter((c) => c.status === "running").length,
    enabled: containers.filter((c) => c.firewall_status === "active").length,
  };
  const token = (tokens.data ?? []).find((t) => t.name === id);

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Containers" to={containersHref(id)} hint="Open this agent's containers">
          {counts.total}
        </Tile>
        <Tile
          label="Running"
          to={containersHref(id, { running: "1" })}
          hint="Open this agent's running containers"
        >
          {counts.running}
        </Tile>
        <Tile
          label="Firewall active"
          to={containersHref(id, { firewall: "active" })}
          hint="Containers with Firefik rules applied"
        >
          {counts.enabled}
        </Tile>
        <Tile
          label="Drops, 24 h"
          to={trafficHref(id, undefined, "DROP")}
          hint="Packets dropped and logged on this host in the last day. Opens the traffic log."
        >
          {drops.data ? drops.data.summary.total.toLocaleString() : "—"}
        </Tile>
        <Tile label="Agent token" to="/agent-tokens" hint="Open agent tokens">
          <span className="text-sm font-medium">
            {token ? "active" : tokens.isLoading ? "…" : "none"}
          </span>
        </Tile>
      </div>
      <p className="text-xs text-muted-foreground">
        Container counts come from the agent's last report
        {snapshotAt ? (
          <>
            {", "}
            <span title={new Date(snapshotAt).toLocaleString()}>{formatRelative(snapshotAt)}</span>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}
