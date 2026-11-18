import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  createAgentToken,
  fetchAgents,
  fetchAgentTokens,
  revokeAgentToken,
  type AgentTokenIssued,
  type AgentTokenRecord,
} from "@/lib/fleetApi";
import { queryKeys } from "@/lib/queryKeys";
import { formatActor } from "@/lib/actor";
import { formatRelative } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { AgentStatusBadge } from "@/components/shared/AgentStatusBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableLoading, TableError } from "@/components/shared/TableStates";

const AGENT_TOKENS_KEY = ["agent-tokens"] as const;

const LAST_CONNECTED_HINT =
  "When an agent last connected with this token: when it starts or reconnects, or answers a command from the panel. Regular check-ins do not change it, so see the Agent column for whether the agent is online.";

export default function AgentTokensPage() {
  const qc = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [issuedSecret, setIssuedSecret] = useState<AgentTokenIssued | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AgentTokenRecord | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: [...AGENT_TOKENS_KEY, includeRevoked] as const,
    queryFn: () => fetchAgentTokens(includeRevoked),
    refetchInterval: 30_000,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents(),
    queryFn: fetchAgents,
    refetchInterval: 30_000,
  });
  const agentByID = new Map((agentsQuery.data ?? []).map((a) => [a.instance_id, a]));

  const create = useMutation({
    mutationFn: () => createAgentToken(name.trim(), description.trim() || undefined),
    onSuccess: (issued) => {
      setIssuedSecret(issued);
      setName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: AGENT_TOKENS_KEY });
      toast.success(`Agent token "${issued.name}" created`);
    },
    onError: (e: Error) => toast.error(`Create failed: ${e.message}`),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeAgentToken(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AGENT_TOKENS_KEY });
      setRevokeTarget(null);
      toast.success("Token revoked");
    },
    onError: (e: Error) => toast.error(`Revoke failed: ${e.message}`),
  });

  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Copied to clipboard"))
      .catch(() => toast.error("clipboard write failed"));
  };

  const tokens = data ?? [];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">Agent tokens</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Most hosts should be added with{" "}
          <Link to="/fleet/add" className="underline">
            Fleet → Add agent
          </Link>
          . Long-lived tokens are only for hosts that cannot use one-time enrollment. A new token is
          shown <strong>once</strong>, so copy it right away, and revoke it here when the host is
          retired.
        </p>
      </div>

      <section className="space-y-2 border rounded p-4">
        <h2 className="text-lg font-semibold">Issue a new token</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="prod-host-01"
              className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Description (optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="primary token for prod"
              className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm"
            />
          </label>
        </div>
        <div>
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Issuing…" : "Issue token"}
          </Button>
        </div>
      </section>

      {issuedSecret && (
        <section className="space-y-2 border-2 border-amber-500/50 rounded p-4 bg-amber-500/5">
          <h2 className="text-lg font-semibold text-amber-700 dark:text-amber-400">
            Copy this token now — it will not be shown again
          </h2>
          <pre className="bg-muted rounded p-3 text-xs overflow-auto font-mono whitespace-pre-wrap break-all">
            {issuedSecret.token}
          </pre>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(issuedSecret.token)}>
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssuedSecret(null)}>
              Dismiss
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            On the agent host, write the value to a file referenced by{" "}
            <code>FIREFIK_CONTROL_PLANE_TOKEN_FILE</code>.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Tokens</h2>
          <label className="text-xs text-muted-foreground flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeRevoked}
              onChange={(e) => setIncludeRevoked(e.target.checked)}
            />
            include revoked
          </label>
        </div>

        {isLoading ? (
          <TableLoading label="Loading tokens…" />
        ) : isError ? (
          <TableError label="Could not load agent tokens." />
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agent tokens issued yet. Most hosts do not need one: add them with{" "}
            <Link to="/fleet/add" className="underline">
              Add agent
            </Link>
            .
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead title={LAST_CONNECTED_HINT}>Last connected</TableHead>
                <TableHead>Issued by</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t: AgentTokenRecord) => {
                const revoked = !!t.revoked_at;
                const agent = agentByID.get(t.name);
                const issuedBy = formatActor(t.issued_by);
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono">
                      <div>{t.name}</div>
                      {t.description && (
                        <div className="text-xs text-muted-foreground">{t.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {revoked ? (
                        <Badge variant="destructive">revoked</Badge>
                      ) : (
                        <Badge variant="default">active</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {agent ? (
                        <Link
                          to={`/fleet/${encodeURIComponent(agent.instance_id)}`}
                          className="inline-flex items-center gap-2 underline"
                          aria-label={`Open agent ${agent.instance_id}`}
                        >
                          <AgentStatusBadge status={agent.status} />
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">no agent</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs" title={new Date(t.issued_at).toLocaleString()}>
                      {formatRelative(t.issued_at)}
                    </TableCell>
                    <TableCell
                      className="text-xs"
                      title={
                        t.last_used_at
                          ? `${new Date(t.last_used_at).toLocaleString()}. ${LAST_CONNECTED_HINT}`
                          : LAST_CONNECTED_HINT
                      }
                    >
                      {t.last_used_at
                        ? `${formatRelative(t.last_used_at)}${t.last_used_ip ? ` · ${t.last_used_ip}` : ""}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={issuedBy.title}>
                      {issuedBy.label}
                    </TableCell>
                    <TableCell className="text-right">
                      {!revoked && (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={revoke.isPending}
                          onClick={() => setRevokeTarget(t)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={`Revoke token "${revokeTarget?.name ?? ""}"?`}
        description="Agents using this token fail authentication on their next reconnect. This cannot be undone; issue a new token to re-enroll the host."
        confirmLabel="Revoke token"
        pending={revoke.isPending}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget.id)}
      />
    </div>
  );
}
