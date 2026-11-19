import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { useLogStream, type KeyedLogEntry } from "@/hooks/useLogStream";
import { fetchAgents, fetchFlows, type FlowFilters, type FlowRow } from "@/lib/fleetApi";
import { queryKeys } from "@/lib/queryKeys";
import { isPanelMode } from "@/lib/panelMode";
import { formatRelative } from "@/lib/time";
import { bucketRange, hourlyBuckets, ruleLabel } from "@/lib/flows";
import {
  isValidSourceFilter,
  PRIVATE_RANGE_LABEL,
  sourceMatches,
  type SourceScope,
} from "@/lib/ip";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/EmptyState";
import { LiveStreamBar, type LiveStreamStatus } from "@/components/shared/TrafficRow";
import { TableError, TableLoading } from "@/components/shared/TableStates";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type View = "live" | "24h" | "7d";
type ActionFilter = "DROP" | "ACCEPT" | "";

interface Filters {
  agent: string;
  container: string;
  src: string;
  scope: SourceScope;
  port: string;
  action: ActionFilter;
}

type FilterPatch = Partial<Filters>;
type OnFilter = (patch: FilterPatch) => void;

const NO_FILTERS: Filters = {
  agent: "",
  container: "",
  src: "",
  scope: "",
  port: "",
  action: "",
};

const VIEWS: readonly (readonly [View, string])[] = [
  ["live", "Live"],
  ["24h", "Last 24 h"],
  ["7d", "7 days"],
];

const ACTIONS: readonly (readonly [ActionFilter, string])[] = [
  ["DROP", "Dropped"],
  ["ACCEPT", "Accepted"],
  ["", "All"],
];

const SCOPES: readonly (readonly [SourceScope, string, string])[] = [
  ["", "Any source", "Sources from any network"],
  ["private", "Private", `Only private sources: ${PRIVATE_RANGE_LABEL}`],
  ["public", "Public", "Only sources outside the private ranges"],
];

const TEXT_FILTER_KEYS = ["agent", "container", "src", "scope", "port"] as const;

const inputClass =
  "border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm";

const pillClass = (active: boolean) =>
  cn(
    "rounded-full border px-3 py-0.5 text-xs",
    active
      ? "bg-primary text-primary-foreground border-primary"
      : "text-muted-foreground hover:bg-accent",
  );

function readView(value: string | null): View {
  return value === "live" || value === "7d" ? value : "24h";
}

function readScope(value: string | null): SourceScope {
  return value === "private" || value === "public" ? value : "";
}

function readAction(value: string | null): ActionFilter {
  if (value === "ACCEPT") return "ACCEPT";
  if (value === "all") return "";
  return "DROP";
}

function ActionBadge({ action }: { action?: string }) {
  if (!action) return null;
  return (
    <Badge
      variant={action === "DROP" ? "destructive" : "default"}
      className="shrink-0 text-[10px] px-1.5 py-0"
    >
      {action}
    </Badge>
  );
}

function FilterValue({
  onFilter,
  patch,
  title,
  className,
  children,
}: {
  onFilter?: OnFilter;
  patch: FilterPatch;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  if (!onFilter) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      title={title}
      onClick={() => onFilter(patch)}
      className={cn(
        "rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </button>
  );
}

export default function LogsPage() {
  return isPanelMode ? <FleetTrafficLog /> : <AgentLiveLog />;
}

function AgentLiveLog() {
  return (
    <div className="space-y-4 h-full flex flex-col">
      <h1 className="text-2xl font-bold">Traffic log</h1>
      <LiveStream filters={NO_FILTERS} showAgent={false} />
    </div>
  );
}

function LiveStream({
  filters,
  showAgent,
  onFilter,
}: {
  filters: Filters;
  showAgent: boolean;
  onFilter?: OnFilter;
}) {
  const { logs, connected } = useLogStream();
  const [everConnected, setEverConnected] = useState(connected);
  const [frozen, setFrozen] = useState<KeyedLogEntry[] | null>(null);
  const [clearedSeq, setClearedSeq] = useState(0);
  const [pausedSeq, setPausedSeq] = useState(0);

  if (connected && !everConnected) setEverConnected(true);

  const status: LiveStreamStatus = connected
    ? "open"
    : everConnected
      ? "reconnecting"
      : "connecting";
  const latestSeq = logs[0]?._id ?? 0;
  const fresh = logs.filter((e) => e._id > clearedSeq);
  const paused = frozen !== null;
  const shown = frozen ?? fresh;
  const visibleCount = shown.filter((e) => matchesLive(e, filters)).length;
  const newWhilePaused = paused
    ? fresh.filter((e) => e._id > pausedSeq && matchesLive(e, filters)).length
    : 0;

  const togglePause = () => {
    if (paused) {
      setFrozen(null);
      return;
    }
    setFrozen(fresh);
    setPausedSeq(latestSeq);
  };

  const clear = () => {
    setClearedSeq(latestSeq);
    if (paused) {
      setFrozen([]);
      setPausedSeq(latestSeq);
    }
  };

  return (
    <div className="space-y-2 flex-1 flex flex-col">
      <LiveStreamBar
        status={status}
        paused={paused}
        lineCount={visibleCount}
        newWhilePaused={newWhilePaused}
        canClear={fresh.length > 0 || shown.length > 0}
        onTogglePause={togglePause}
        onClear={clear}
      />
      <LiveEntries entries={shown} filters={filters} showAgent={showAgent} onFilter={onFilter} />
    </div>
  );
}

function liveContainer(e: KeyedLogEntry): string {
  return e.containerName || e.container || "";
}

function matchesLive(e: KeyedLogEntry, f: Filters): boolean {
  if (f.action && e.action !== f.action) return false;
  if (f.agent && e.agent !== f.agent) return false;
  if (f.container && !liveContainer(e).toLowerCase().includes(f.container.toLowerCase()))
    return false;
  if ((f.src || f.scope) && !sourceMatches(e.srcIP ?? "", f.src, f.scope)) return false;
  if (f.port && String(e.dstPort ?? "") !== f.port) return false;
  return true;
}

function TrafficLine({
  entry,
  showAgent,
  onFilter,
}: {
  entry: KeyedLogEntry;
  showAgent: boolean;
  onFilter?: OnFilter;
}) {
  const container = liveContainer(entry);
  return (
    <div className="flex flex-wrap gap-x-3 items-baseline leading-5">
      <span className="text-muted-foreground shrink-0">
        {new Date(entry.ts).toLocaleTimeString()}
      </span>
      <ActionBadge action={entry.action} />
      {showAgent && entry.agent && (
        <FilterValue
          onFilter={onFilter}
          patch={{ agent: entry.agent }}
          title={`Show only agent ${entry.agent}`}
          className="text-muted-foreground"
        >
          {entry.agent}
        </FilterValue>
      )}
      {entry.srcIP && (
        <FilterValue
          onFilter={onFilter}
          patch={{ src: entry.srcIP }}
          title={`Show only traffic from ${entry.srcIP}`}
          className="text-foreground shrink-0"
        >
          {entry.srcIP}
        </FilterValue>
      )}
      <span className="text-muted-foreground" aria-hidden>
        →
      </span>
      {container && (
        <FilterValue
          onFilter={onFilter}
          patch={{ container }}
          title={`Show only ${container}`}
          className="text-blue-600 dark:text-blue-400 shrink-0"
        >
          {container}
        </FilterValue>
      )}
      {entry.dstPort != null && (
        <FilterValue
          onFilter={onFilter}
          patch={{ port: String(entry.dstPort) }}
          title={`Show only port ${entry.dstPort}`}
          className="text-muted-foreground shrink-0"
        >
          :{entry.dstPort}
        </FilterValue>
      )}
      {entry.proto && <span className="text-muted-foreground">{entry.proto.toLowerCase()}</span>}
      {entry.rule && <span className="text-muted-foreground">· {ruleLabel(entry.rule)}</span>}
    </div>
  );
}

function LiveEntries({
  entries,
  filters,
  showAgent,
  onFilter,
}: {
  entries: KeyedLogEntry[];
  filters: Filters;
  showAgent: boolean;
  onFilter?: OnFilter;
}) {
  const visible = entries.filter((e) => matchesLive(e, filters));
  return (
    <div className="flex-1 min-h-64 overflow-auto font-mono text-xs border rounded-md bg-muted/30 p-3 space-y-0.5">
      {visible.length === 0 && (
        <p className="text-muted-foreground font-sans text-sm">
          Waiting for firewall events…
          {entries.length > 0 && " Nothing matches the current filters yet."}
        </p>
      )}
      {visible.map((entry) => (
        <TrafficLine key={entry._id} entry={entry} showAgent={showAgent} onFilter={onFilter} />
      ))}
    </div>
  );
}

function FleetTrafficLog() {
  const [params, setParams] = useSearchParams();
  const view = readView(params.get("view"));
  const filters: Filters = {
    agent: params.get("agent") ?? "",
    container: params.get("container") ?? "",
    src: params.get("src") ?? "",
    scope: readScope(params.get("scope")),
    port: params.get("port") ?? "",
    action: readAction(params.get("action")),
  };

  const update = (mutate: (next: URLSearchParams) => void) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      },
      { replace: true },
    );

  const set: OnFilter = (patch) =>
    update((next) => {
      for (const key of TEXT_FILTER_KEYS) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (patch.action !== undefined) {
        if (patch.action === "DROP") next.delete("action");
        else next.set("action", patch.action || "all");
      }
    });

  const setView = (v: View) =>
    update((next) => {
      if (v === "24h") next.delete("view");
      else next.set("view", v);
    });

  const reset = () =>
    update((next) => {
      for (const key of TEXT_FILTER_KEYS) next.delete(key);
      next.delete("action");
    });

  const agents = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const agentList = agents.data ?? [];
  const agentKnown = agentList.some((a) => a.instance_id === filters.agent);
  const srcValid = isValidSourceFilter(filters.src);
  const activeFilters = srcValid ? filters : { ...filters, src: "" };

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Traffic log</h1>
        <div className="flex gap-1" role="group" aria-label="Time range">
          {VIEWS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={pillClass(view === v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          id="logs-agent"
          value={filters.agent}
          onChange={(e) => set({ agent: e.target.value })}
          aria-label="Agent"
          className={inputClass}
        >
          <option value="">All agents</option>
          {filters.agent && !agentKnown && <option value={filters.agent}>{filters.agent}</option>}
          {agentList.map((a) => (
            <option key={a.instance_id} value={a.instance_id} title={a.hostname || undefined}>
              {a.instance_id}
            </option>
          ))}
        </select>
        <input
          id="logs-container"
          value={filters.container}
          onChange={(e) => set({ container: e.target.value.trim() })}
          placeholder="Container (or host)"
          aria-label="Container"
          className={cn(inputClass, "w-44")}
        />
        <input
          id="logs-src"
          value={filters.src}
          onChange={(e) => set({ src: e.target.value.trim() })}
          placeholder="Source IP, prefix or CIDR"
          aria-label="Source"
          aria-invalid={!srcValid || undefined}
          title={srcValid ? "e.g. 185.220.101.7, 172. or 172.16.0.0/12" : "Not a valid CIDR"}
          className={cn(inputClass, "w-52", !srcValid && "border-destructive")}
        />
        <div className="flex gap-1" role="group" aria-label="Source network">
          {SCOPES.map(([s, label, hint]) => (
            <button
              key={label}
              type="button"
              title={hint}
              aria-pressed={filters.scope === s}
              onClick={() => set({ scope: s })}
              className={pillClass(filters.scope === s)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          id="logs-port"
          value={filters.port}
          onChange={(e) => set({ port: e.target.value.replace(/\D/g, "").slice(0, 5) })}
          placeholder="Port"
          aria-label="Port"
          inputMode="numeric"
          className={cn(inputClass, "w-20")}
        />
        <div className="flex gap-1" role="group" aria-label="Action">
          {ACTIONS.map(([a, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={filters.action === a}
              onClick={() => set({ action: a })}
              className={pillClass(filters.action === a)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={reset}>
          Reset
        </Button>
      </div>

      {view === "live" ? (
        <LiveStream filters={activeFilters} showAgent onFilter={set} />
      ) : (
        <FlowHistory view={view} filters={activeFilters} onFilter={set} />
      )}

      <p className="text-xs text-muted-foreground">
        Every agent logs dropped packets; history is kept for 7 days.{" "}
        <Link to="/help/traffic" className="underline">
          How the traffic log works
        </Link>
      </p>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-3 min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{children}</div>
    </div>
  );
}

function HourlySparkline({
  hourly,
  hours,
  now,
  tone,
}: {
  hourly: { at: string; count: number }[];
  hours: number;
  now: number;
  tone: "drop" | "other";
}) {
  const buckets = hourlyBuckets(hourly, hours, now);
  const { min, max } = bucketRange(buckets);
  if (max === 0) return <span className="text-sm text-muted-foreground">—</span>;
  const span = hours > 24 ? "7 days" : "24 hours";
  return (
    <div className="space-y-0.5">
      <div
        role="img"
        aria-label={`Events per hour over the last ${span}: lowest ${min.toLocaleString()}, highest ${max.toLocaleString()}`}
        className={cn("flex items-end h-8", hours <= 48 && "gap-px")}
      >
        {buckets.map((b) => (
          <span
            key={b.at}
            title={`${new Date(b.at).toLocaleString()}: ${(b.count ?? 0).toLocaleString()}`}
            className={cn(
              "flex-1 min-w-0 rounded-[1px]",
              tone === "drop" ? "bg-red-500/80" : "bg-primary/70",
            )}
            style={{ height: b.count ? `${Math.max(8, (b.count / max) * 100)}%` : 0 }}
          />
        ))}
      </div>
      <div className="flex justify-between gap-2 text-[10px] font-normal text-muted-foreground">
        <span>{hours > 24 ? "7 d ago" : "24 h ago"}</span>
        <span>
          min {min.toLocaleString()} · max {max.toLocaleString()}
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

function FlowHistory({
  view,
  filters,
  onFilter,
}: {
  view: Exclude<View, "live">;
  filters: Filters;
  onFilter: OnFilter;
}) {
  const query: FlowFilters = {
    since: view,
    agent_id: filters.agent,
    container: filters.container,
    src: filters.src,
    scope: filters.scope,
    port: filters.port,
    action: filters.action,
  };
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ["flows", query],
    queryFn: () => fetchFlows(query),
    refetchInterval: 15_000,
  });

  if (isLoading) return <TableLoading label="Loading traffic log…" />;
  if (isError || !data) return <TableError label="Could not load the traffic log." />;

  const verb =
    filters.action === "ACCEPT" ? "Accepted" : filters.action === "DROP" ? "Dropped" : "Events";
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={`${verb}, ${view === "7d" ? "7 days" : "24 h"}`}>
          {data.summary.total.toLocaleString()}
        </Stat>
        <Stat label="Unique sources">{data.summary.unique_sources.toLocaleString()}</Stat>
        <Stat label="Top port">
          {data.summary.top_port ? (
            <>
              {data.summary.top_port}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {data.summary.top_port_count.toLocaleString()} hits
              </span>
            </>
          ) : (
            "—"
          )}
        </Stat>
        <Stat label="Per hour">
          <HourlySparkline
            hourly={data.hourly}
            hours={view === "7d" ? 7 * 24 : 24}
            now={dataUpdatedAt}
            tone={filters.action === "DROP" ? "drop" : "other"}
          />
        </Stat>
      </div>

      {data.rows.length === 0 ? (
        filters.action === "ACCEPT" ? (
          <EmptyState title="No accepted traffic logged in this period" helpAnchor="traffic">
            <p>
              Accepted packets are logged only for rules that have{" "}
              <code className="bg-muted px-1 rounded">log: true</code>. Dropped packets are always
              logged.
            </p>
          </EmptyState>
        ) : (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No matching traffic in this period.
          </p>
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Last seen</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Container</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Matched rule</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r: FlowRow) => (
              <TableRow
                key={`${r.agent_id}|${r.action}|${r.container}|${r.src_ip}|${r.dst_port}|${r.proto}|${r.rule}`}
              >
                <TableCell title={new Date(r.last_seen).toLocaleString()}>
                  {formatRelative(r.last_seen)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.count.toLocaleString()}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  <FilterValue
                    onFilter={onFilter}
                    patch={{ agent: r.agent_id }}
                    title={`Show only agent ${r.agent_id}`}
                  >
                    {r.agent_id}
                  </FilterValue>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {r.container ? (
                    <FilterValue
                      onFilter={onFilter}
                      patch={{ container: r.container }}
                      title={`Show only ${r.container}`}
                    >
                      {r.container}
                    </FilterValue>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {r.src_ip ? (
                    <FilterValue
                      onFilter={onFilter}
                      patch={{ src: r.src_ip }}
                      title={`Show only traffic from ${r.src_ip}`}
                    >
                      {r.src_ip}
                    </FilterValue>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {r.dst_port ? (
                    <FilterValue
                      onFilter={onFilter}
                      patch={{ port: String(r.dst_port) }}
                      title={`Show only port ${r.dst_port}`}
                    >
                      :{r.dst_port}
                    </FilterValue>
                  ) : (
                    "—"
                  )}
                  {r.proto && (
                    <span className="text-muted-foreground">/{r.proto.toLowerCase()}</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <ActionBadge action={r.action} />
                    <span className="text-xs">{ruleLabel(r.rule)}</span>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
