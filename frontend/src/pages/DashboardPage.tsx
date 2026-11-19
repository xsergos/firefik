import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchStats } from "@/lib/api";
import { fetchFleetStats, fetchFlows } from "@/lib/fleetApi";
import { useContainers } from "@/hooks/useContainers";
import { plural } from "@/lib/firewallState";
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
const SOURCE_BUCKET_MINUTES = 1;

type Series = { points: StatsResponse["traffic"]; bucketMinutes: number };

function unitLabel(bucketMinutes: number): string {
  return bucketMinutes === 1 ? "packets/min" : `packets per ${bucketMinutes} min`;
}

function downsample(points: StatsResponse["traffic"]): Series {
  if (points.length <= MAX_POINTS) return { points, bucketMinutes: SOURCE_BUCKET_MINUTES };
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
  return { points: out, bucketMinutes: bucketSize * SOURCE_BUCKET_MINUTES };
}

const EMPTY_SERIES: Series = { points: [], bucketMinutes: SOURCE_BUCKET_MINUTES };

function useFleetStats() {
  return useQuery<FleetStats>({
    queryKey: ["fleet-stats"],
    queryFn: () => fetchFleetStats(),
    refetchInterval: 15_000,
  });
}

type AttentionItem = { key: string; text: string; to: string };

const HIDDEN_ATTENTION_KEY = "firefik.dashboard.hiddenAttention";

function readHiddenAttention(): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_ATTENTION_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function writeHiddenAttention(keys: string[]) {
  try {
    window.localStorage.setItem(HIDDEN_ATTENTION_KEY, JSON.stringify(keys));
  } catch {
    return;
  }
}

function NeedsAttention({ items }: { items: AttentionItem[] }) {
  const [hidden, setHidden] = useState<string[]>(readHiddenAttention);
  const [showHidden, setShowHidden] = useState(false);
  if (items.length === 0) return null;

  const updateHidden = (next: string[]) => {
    setHidden(next);
    writeHiddenAttention(next);
    if (!items.some((i) => next.includes(i.key))) setShowHidden(false);
  };
  const hiddenItems = items.filter((i) => hidden.includes(i.key));
  const visible = showHidden ? items : items.filter((i) => !hidden.includes(i.key));
  const toggleLabel = showHidden ? "Hide hidden issues" : `Show hidden (${hiddenItems.length})`;

  if (visible.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {plural(hiddenItems.length, "hidden issue")}.{" "}
        <button
          type="button"
          onClick={() => setShowHidden(true)}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Show
        </button>
      </p>
    );
  }

  return (
    <section
      aria-labelledby="needs-attention-title"
      className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="needs-attention-title"
          className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300"
        >
          <AlertTriangle className="h-4 w-4" aria-hidden />
          Needs attention
        </h2>
        {hiddenItems.length > 0 && (
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {toggleLabel}
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {visible.map((item) => {
          const isHidden = hidden.includes(item.key);
          return (
            <li key={item.key} className="flex items-center justify-between gap-3">
              <Link
                to={item.to}
                className={`underline underline-offset-2 hover:text-foreground ${isHidden ? "text-muted-foreground" : ""}`}
              >
                {item.text}
              </Link>
              <button
                type="button"
                onClick={() =>
                  updateHidden(
                    isHidden ? hidden.filter((k) => k !== item.key) : [...hidden, item.key],
                  )
                }
                aria-label={`${isHidden ? "Unhide" : "Hide"}: ${item.text}`}
                className="shrink-0 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-amber-500/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {isHidden ? "Unhide" : "Hide"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function useAttentionItems(agents: FleetStats["agents"] | undefined): AttentionItem[] {
  const containers = useContainers();
  const drops = useQuery({
    queryKey: ["flows", { since: "1h", action: "DROP" }],
    queryFn: () => fetchFlows({ since: "1h", action: "DROP" }),
    refetchInterval: 60_000,
  });
  const items: AttentionItem[] = [];
  if (agents?.dead) {
    items.push({
      key: "dead",
      text: `${plural(agents.dead, "agent")} stopped reporting`,
      to: "/fleet?status=dead",
    });
  }
  if (agents?.stale) {
    items.push({
      key: "stale",
      text: `${plural(agents.stale, "agent")} reporting late`,
      to: "/fleet?status=stale",
    });
  }
  const pending = (containers.data ?? []).filter((c) => c.firewallStatus === "inactive").length;
  if (pending) {
    items.push({
      key: "pending",
      text: `${plural(pending, "container")} waiting for firewall rules to be applied`,
      to: "/containers?firewall=inactive",
    });
  }
  const dropped = drops.data?.summary.total ?? 0;
  if (dropped) {
    items.push({
      key: "drops",
      text: `${dropped.toLocaleString()} ${dropped === 1 ? "packet" : "packets"} dropped in the last hour`,
      to: "/logs",
    });
  }
  return items;
}

function FleetDashboard() {
  const { data, isLoading, isError } = useFleetStats();
  const attention = useAttentionItems(data?.agents);
  const fleetTraffic = useMemo(
    () => (data?.traffic ? downsample(data.traffic) : EMPTY_SERIES),
    [data],
  );
  if (isError) {
    return (
      <TableError label="Failed to load fleet stats. Make sure the control plane is running." />
    );
  }
  const a = data?.agents ?? { total: 0, healthy: 0, stale: 0, dead: 0, unknown: 0 };
  const c = data?.containers ?? { total: 0, running: 0, enabled: 0 };
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <NeedsAttention items={attention} />
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <StatCard title="Agents (total)" value={isLoading ? "…" : String(a.total)} to="/fleet" />
        <StatCard
          title="Healthy"
          value={isLoading ? "…" : String(a.healthy)}
          to="/fleet?status=healthy"
        />
        <StatCard
          title="Stale"
          value={isLoading ? "…" : String(a.stale)}
          to="/fleet?status=stale"
        />
        <StatCard title="Dead" value={isLoading ? "…" : String(a.dead)} to="/fleet?status=dead" />
      </div>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <StatCard
          title="Containers (total)"
          value={isLoading ? "…" : String(c.total)}
          to="/containers"
        />
        <StatCard
          title="Running"
          value={isLoading ? "…" : String(c.running)}
          to="/containers?running=1"
        />
        <StatCard
          title="Firewall active"
          value={isLoading ? "…" : String(c.enabled)}
          to="/containers?firewall=active"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fleet traffic (sum across all agents)</CardTitle>
          <p className="text-xs text-muted-foreground">
            Counts logged packets only: default-policy drops and rules with logging on. See the{" "}
            <Link to="/logs" className="underline">
              Traffic log
            </Link>{" "}
            for details.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableLoading label="Loading traffic data…" />
          ) : fleetTraffic.points.length > 0 ? (
            <Suspense fallback={<TableLoading label="Loading traffic data…" />}>
              <TrafficChart
                data={fleetTraffic.points}
                gradientPrefix="colorFleet"
                unit={unitLabel(fleetTraffic.bucketMinutes)}
              />
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

  const traffic = useMemo(() => (data?.traffic ? downsample(data.traffic) : EMPTY_SERIES), [data]);

  if (isError)
    return <TableError label="Failed to load dashboard stats. Make sure the backend is running." />;

  const total = data?.containers.total ?? 0;
  const running = data?.containers.running ?? 0;
  const enabled = data?.containers.enabled ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <StatCard
          title="Total containers"
          value={isLoading ? "…" : String(total)}
          to="/containers"
        />
        <StatCard
          title="Running"
          value={isLoading ? "…" : String(running)}
          to="/containers?running=1"
        />
        <StatCard
          title="Firewall active"
          value={isLoading ? "…" : String(enabled)}
          to="/containers?firewall=active"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Traffic (last 60 min)</CardTitle>
          <p className="text-xs text-muted-foreground">
            Counts logged packets only: default-policy drops and rules with logging on. See the{" "}
            <Link to="/logs" className="underline">
              Traffic log
            </Link>{" "}
            for details.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <TableLoading label="Loading traffic data…" />
          ) : traffic.points.length > 0 ? (
            <Suspense fallback={<TableLoading label="Loading traffic data…" />}>
              <TrafficChart
                data={traffic.points}
                gradientPrefix="color"
                unit={unitLabel(traffic.bucketMinutes)}
              />
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

function StatCard({ title, value, to }: { title: string; value: string; to: string }) {
  return (
    <Link
      to={to}
      className="group block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-colors group-hover:bg-muted/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-bold">{value}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
