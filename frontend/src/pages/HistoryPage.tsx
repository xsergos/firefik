import { Fragment, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fetchAuditHistory } from "@/lib/api";
import { fetchPolicyVersions } from "@/lib/fleetApi";
import { useContainers } from "@/hooks/useContainers";
import { isPanelMode } from "@/lib/panelMode";
import { formatRelative } from "@/lib/time";
import { lineDiff } from "@/lib/diff";
import {
  CHANGE_KINDS,
  WHERE_LEGEND,
  actorDisplay,
  actorKeyDisplay,
  changeActor,
  changeKind,
  changeTarget,
  containerNameIndex,
  describeChange,
  detailEntries,
  groupRepeats,
  resolveTarget,
  uniqueEventKeys,
  whereInfo,
  type ChangeKind,
  type HistoryGroup,
} from "@/lib/history";
import type { AuditHistoryEvent } from "@/types/api";
import { TableError, TableLoading } from "@/components/shared/TableStates";
import { cn } from "@/lib/utils";

type Filter = {
  kind: ChangeKind | "";
  agent: string;
  actor: string;
  search: string;
};

const FILTER_KEYS = ["kind", "agent", "actor", "search"] as const;

const inputClass =
  "border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm";

function readKind(value: string | null): ChangeKind | "" {
  const match = CHANGE_KINDS.find((k) => k.value === value);
  return match ? match.value : "";
}

function applyFilter(
  events: AuditHistoryEvent[],
  f: Filter,
  names: ReadonlyMap<string, string> | undefined,
): AuditHistoryEvent[] {
  const needle = f.search.trim().toLowerCase();
  return events.filter((ev) => {
    if (f.kind && changeKind(ev.action) !== f.kind) return false;
    if (f.agent && ev.agent_id !== f.agent) return false;
    if (f.actor && changeActor(ev) !== f.actor) return false;
    if (needle) {
      const hay = [
        ev.action,
        describeChange(ev),
        changeTarget(ev),
        resolveTarget(ev, names).label,
        actorDisplay(ev).label,
        ev.actor ?? "",
        ev.container_id ?? "",
        ev.container_name ?? "",
        ev.agent_id ?? "",
        ev.agent_hostname ?? "",
        ...Object.values(ev.metadata ?? {}),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export default function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const kind = readKind(params.get("kind"));
  const agent = params.get("agent") ?? "";
  const actor = params.get("actor") ?? "";
  const search = params.get("search") ?? "";
  const set = (patch: Partial<Filter>) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of FILTER_KEYS) {
          if (!(key in patch)) continue;
          const value = patch[key];
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  };
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const detailsId = useId();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["audit-history"],
    queryFn: () => fetchAuditHistory(500),
    refetchInterval: autoRefresh ? 5000 : false,
  });
  const containers = useContainers();

  const all = useMemo(() => data ?? [], [data]);
  const names = useMemo(
    () => (containers.data ? containerNameIndex(containers.data) : undefined),
    [containers.data],
  );
  const events = useMemo(
    () => applyFilter(all, { kind, agent, actor, search }, names),
    [all, kind, agent, actor, search, names],
  );
  const groups = useMemo(() => groupRepeats(events), [events]);
  const keys = useMemo(() => uniqueEventKeys(groups.map((g) => g.head)), [groups]);
  const agents = useMemo(() => {
    const byId = new Map<string, string>();
    for (const e of all) {
      if (e.agent_id && !byId.has(e.agent_id)) byId.set(e.agent_id, e.agent_hostname ?? "");
    }
    return Array.from(byId.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [all]);
  const actors = useMemo(() => Array.from(new Set(all.map(changeActor))).sort(), [all]);
  const columns = isPanelMode ? 7 : 6;
  const loadError = error instanceof Error && error.message ? `: ${error.message}` : ".";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Change history</h1>
        <span className="text-sm text-muted-foreground">
          {isPanelMode
            ? "Who changed what across the fleet. Kept for 90 days."
            : "Recent rule changes on this agent (last 500 events)."}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <select
          id="history-kind"
          aria-label="Kind of change"
          value={kind}
          onChange={(e) => set({ kind: readKind(e.target.value) })}
          className={inputClass}
        >
          {CHANGE_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        {isPanelMode && (agents.length > 0 || agent) && (
          <select
            id="history-agent"
            aria-label="Agent"
            value={agent}
            onChange={(e) => set({ agent: e.target.value })}
            className={inputClass}
          >
            <option value="">All agents</option>
            {agent && !agents.some(([id]) => id === agent) && (
              <option value={agent}>{agent}</option>
            )}
            {agents.map(([id, hostname]) => (
              <option key={id} value={id} title={hostname || undefined}>
                {id}
              </option>
            ))}
          </select>
        )}
        {(actors.length > 1 || actor) && (
          <select
            id="history-actor"
            aria-label="Who"
            value={actor}
            onChange={(e) => set({ actor: e.target.value })}
            className={inputClass}
          >
            <option value="">Anyone</option>
            {actor && !actors.includes(actor) && (
              <option value={actor}>{actorKeyDisplay(actor).label}</option>
            )}
            {actors.map((a) => {
              const who = actorKeyDisplay(a);
              return (
                <option key={a} value={a} title={who.title || undefined}>
                  {who.label}
                </option>
              );
            })}
          </select>
        )}
        <input
          id="history-search"
          type="search"
          aria-label="Search"
          placeholder="Search policy, container, token…"
          value={search}
          onChange={(e) => set({ search: e.target.value })}
          className={cn(inputClass, "w-64 max-w-full")}
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            id="history-autorefresh"
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh
        </label>
        <button
          type="button"
          onClick={() => refetch()}
          className="border px-3 py-1 rounded text-sm hover:bg-accent"
        >
          Refresh
        </button>
      </div>

      {isLoading ? (
        <TableLoading label="Loading change history…" />
      ) : error && !data ? (
        <TableError label={`Could not load the change history${loadError}`} />
      ) : (
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-sm" aria-label="Change history table">
            <thead className="bg-muted/50">
              <tr>
                <th className="w-8">
                  <span className="sr-only">Details</span>
                </th>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Who</th>
                <th className="text-left px-3 py-2">Change</th>
                <th className="text-left px-3 py-2">Target</th>
                {isPanelMode && <th className="text-left px-3 py-2">Agent</th>}
                <th className="text-left px-3 py-2">Where</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group, i) => {
                const ev = group.head;
                const repeats = group.events.length;
                const key = keys[i] ?? String(i);
                const expanded = open === key;
                const rowDetailsId = `${detailsId}-details-${i}`;
                const toggle = () => setOpen(expanded ? null : key);
                const who = actorDisplay(ev);
                const target = resolveTarget(ev, names);
                const where = whereInfo(ev);
                const summary = describeChange(ev);
                return (
                  <Fragment key={key}>
                    <tr className="border-t hover:bg-accent/30 cursor-pointer" onClick={toggle}>
                      <td className="pl-1">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={rowDetailsId}
                          aria-label={`${expanded ? "Hide" : "Show"} details: ${summary}${repeats > 1 ? `, ${repeats} times` : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle();
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {expanded ? (
                            <ChevronDown className="h-4 w-4" aria-hidden />
                          ) : (
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          )}
                        </button>
                      </td>
                      <td
                        className="px-3 py-1.5 whitespace-nowrap"
                        title={new Date(ev.ts).toLocaleString()}
                      >
                        {formatRelative(ev.ts)}
                      </td>
                      <td className="px-3 py-1.5 text-xs" title={who.title || undefined}>
                        {who.label}
                      </td>
                      <td className="px-3 py-1.5">
                        {summary}
                        {repeats > 1 && (
                          <span
                            className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                            title={`Recorded ${repeats} times within a minute`}
                          >
                            ×{repeats}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {target.label || "—"}
                        {target.secondary && (
                          <span className="ml-2 text-muted-foreground">{target.secondary}</span>
                        )}
                      </td>
                      {isPanelMode && (
                        <td
                          className="px-3 py-1.5 font-mono text-xs"
                          title={ev.agent_hostname || undefined}
                        >
                          {ev.agent_id || ev.agent_hostname || "—"}
                        </td>
                      )}
                      <td
                        className="px-3 py-1.5 text-xs text-muted-foreground"
                        title={where.description || undefined}
                      >
                        {where.label}
                      </td>
                    </tr>
                    {expanded && (
                      <tr id={rowDetailsId} className="bg-muted/20">
                        <td></td>
                        <td colSpan={columns - 1} className="px-3 py-3">
                          <ChangeDetails group={group} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {events.length === 0 && (
                <tr>
                  <td colSpan={columns} className="px-3 py-6 text-center text-muted-foreground">
                    {all.length === 0
                      ? "No changes recorded yet."
                      : "No changes match the current filters."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        Showing {events.length} of {all.length} events.
      </div>
      <WhereLegend />
    </div>
  );
}

function WhereLegend() {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">What does “Where” mean?</summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {WHERE_LEGEND.map((w) => (
          <Fragment key={w.label}>
            <dt className="font-medium text-foreground">{w.label}</dt>
            <dd>{w.description}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}

function ChangeDetails({ group }: { group: HistoryGroup }) {
  const ev = group.head;
  const entries = detailEntries(ev);
  const who = actorDisplay(ev);
  const policyName = ev.action === "policy_saved" ? ev.metadata?.policy_name : undefined;
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {new Date(ev.ts).toLocaleString()} · by <span className="text-foreground">{who.label}</span>
        {ev.actor && ev.actor !== who.label && (
          <span className="ml-1 font-mono break-all">({ev.actor})</span>
        )}
      </div>
      {group.events.length > 1 && (
        <div className="text-xs">
          <p className="text-muted-foreground">
            The same change was recorded {group.events.length} times:
          </p>
          <ul className="mt-1 space-y-0.5 font-mono" aria-label="All times recorded">
            {group.events.map((e, i) => (
              <li key={`${e.ts}-${i}`}>{new Date(e.ts).toLocaleString()}</li>
            ))}
          </ul>
        </div>
      )}
      {policyName && isPanelMode && (
        <PolicyDiff
          name={policyName}
          sha={ev.metadata?.sha ?? ""}
          previousSha={ev.metadata?.previous_sha ?? ""}
        />
      )}
      {entries.length > 0 ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          {entries.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{k.replace(/_/g, " ")}</dt>
              <dd className="font-mono break-all">{v}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">No extra details recorded.</p>
      )}
    </div>
  );
}

function PolicyDiff({
  name,
  sha,
  previousSha,
}: {
  name: string;
  sha: string;
  previousSha: string;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["policy-versions", name],
    queryFn: () => fetchPolicyVersions(name),
  });
  if (isLoading) return <TableLoading label="Loading versions…" />;
  if (isError || !data) return <TableError label="Could not load the policy versions." />;
  const current = data.find((v) => v.sha === sha);
  const previous = previousSha ? data.find((v) => v.sha === previousSha) : undefined;
  if (!current) {
    return <p className="text-xs text-muted-foreground">This version is no longer stored.</p>;
  }
  const lines = lineDiff(previous?.dsl ?? "", current.dsl);
  return (
    <div className="space-y-1">
      {current.comment && (
        <p className="text-xs">
          Comment: <span className="italic">“{current.comment}”</span>
        </p>
      )}
      <pre
        className="text-xs font-mono bg-background border rounded p-2 overflow-x-auto leading-5"
        aria-label="Policy diff"
      >
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              l.kind === "add" && "text-green-600 dark:text-green-400",
              l.kind === "del" && "text-red-600 dark:text-red-400",
              l.kind === "same" && "text-muted-foreground",
            )}
          >
            {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
            {l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
