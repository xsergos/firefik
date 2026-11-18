import { lazy, Suspense, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchStats } from "@/lib/api";
import { fetchFleetStats } from "@/lib/fleetApi";
import { isPanelMode } from "@/lib/panelMode";
import { queryKeys } from "@/lib/queryKeys";
import type { StatsResponse } from "@/types/api";
import type { FleetStats } from "@/lib/fleetApi";
import { TableLoading, TableError } from "@/components/shared/TableStates";

const TrafficChart = lazy(() => import("./TrafficChart"));

function useStats() {
  return useQuery<StatsResponse>({
    queryKey: queryKeys.stats(),
    queryFn: ({ signal }) => fetchStats({ signal }),
    refetchInterval: 15_000,
  });
}

const MAX_POINTS = 300;

function downsample(points: StatsResponse["traffic"]): StatsResponse["traffic"] {
  if (points.length <= MAX_POINTS) return points;
  const bucketSize = Math.ceil(points.length / MAX_POINTS);
  const out: StatsResponse["traffic"] = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const slice = points.slice(i, i + bucketSize);
    let accepted = 0;
    let dropped = 0;
    for (const p of slice) {
      accepted += p.accepted;
      dropped += p.dropped;
    }
    const first = slice[0];
    if (!first) continue;
    out.push({ ts: first.ts, accepted, dropped });
  }
  return out;
}

function useFleetStats() {
  return useQuery<FleetStats>({
    queryKey: ["fleet-stats"],
    queryFn: () => fetchFleetStats(),
    refetchInterval: 15_000,
  });
}

function FleetDashboard() {
  const { data, isLoading, isError } = useFleetStats();
  const fleetTraffic = useMemo(() => (data?.traffic ? downsample(data.traffic) : []), [data]);
  if (isError) {
    return (
      <TableError label="Failed to load fleet stats. Make sure the control plane is running." />
    );
  }
  const a = data?.agents ?? { total: 0, healthy: 0, stale: 0, dead: 0, unknown: 0 };
  const c = data?.containers ?? { total: 0, running: 0, enabled: 0 };
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Fleet dashboard</h1>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <StatCard title="Agents (total)" value={isLoading ? "…" : String(a.total)} />
        <StatCard title="Healthy" value={isLoading ? "…" : String(a.healthy)} />
        <StatCard title="Stale" value={isLoading ? "…" : String(a.stale)} />
        <StatCard title="Dead" value={isLoading ? "…" : String(a.dead)} />
      </div>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <StatCard title="Containers (total)" value={isLoading ? "…" : String(c.total)} />
        <StatCard title="Running" value={isLoading ? "…" : String(c.running)} />
        <StatCard title="Firewall enabled" value={isLoading ? "…" : String(c.enabled)} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fleet traffic (sum across all agents)</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableLoading label="Loading traffic data…" />
          ) : fleetTraffic.length > 0 ? (
            <Suspense fallback={<TableLoading label="Loading traffic data…" />}>
              <TrafficChart data={fleetTraffic} gradientPrefix="colorFleet" />
            </Suspense>
          ) : (
            <p className="text-sm text-muted-foreground py-10 text-center">
              No traffic from any agent yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function DashboardPage() {
  if (isPanelMode) {
    return <FleetDashboard />;
  }
  return <SingleAgentDashboard />;
}

function SingleAgentDashboard() {
  const { data, isLoading, isError } = useStats();

  const traffic = useMemo(() => (data?.traffic ? downsample(data.traffic) : []), [data]);

  if (isError)
    return <TableError label="Failed to load dashboard stats. Make sure the backend is running." />;

  const total = data?.containers.total ?? 0;
  const running = data?.containers.running ?? 0;
  const enabled = data?.containers.enabled ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <StatCard title="Total containers" value={isLoading ? "…" : String(total)} />
        <StatCard title="Running" value={isLoading ? "…" : String(running)} />
        <StatCard title="Firewall enabled" value={isLoading ? "…" : String(enabled)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Traffic (last 60 min)</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableLoading label="Loading traffic data…" />
          ) : traffic.length > 0 ? (
            <Suspense fallback={<TableLoading label="Loading traffic data…" />}>
              <TrafficChart data={traffic} gradientPrefix="color" />
            </Suspense>
          ) : (
            <p className="text-sm text-muted-foreground py-10 text-center">
              No traffic data yet. Firewall events will appear here.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}
