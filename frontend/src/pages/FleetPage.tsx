import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchAgents } from "@/lib/fleetApi";
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

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  healthy: "default",
  stale: "secondary",
  dead: "destructive",
  unknown: "outline",
};

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export default function FleetPage() {
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: queryKeys.agents(),
    queryFn: fetchAgents,
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-4" aria-busy={isFetching}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Fleet</h1>
        <Button asChild size="sm">
          <Link to="/fleet/add">+ Add agent</Link>
        </Button>
      </div>
      {isLoading ? (
        <TableLoading label="Loading agents…" />
      ) : isError ? (
        <TableError label="Could not connect to control plane." />
      ) : !data || data.length === 0 ? (
        <p className="text-muted-foreground">
          No agents registered yet. Run{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">firefik-admin enroll</code> on a
          host to add it to the fleet.
        </p>
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((agent) => (
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
                  <Badge variant={STATUS_VARIANT[agent.status] ?? "outline"}>{agent.status}</Badge>
                </TableCell>
                <TableCell>{formatRelative(agent.last_seen)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{agent.version}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
