import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAuditHistory, type AuditHistoryEvent } from "@/lib/api";
import { isPanelMode } from "@/lib/panelMode";

type Filter = {
  action: string;
  source: string;
  container: string;
};

function applyFilter(events: AuditHistoryEvent[], f: Filter): AuditHistoryEvent[] {
  return events.filter((ev) => {
    if (f.action && !ev.action.toLowerCase().includes(f.action.toLowerCase())) return false;
    if (f.source && !ev.source.toLowerCase().includes(f.source.toLowerCase())) return false;
    if (f.container) {
      const needle = f.container.toLowerCase();
      const hay = `${ev.container_id ?? ""} ${ev.container_name ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export default function HistoryPage() {
  const [filter, setFilter] = useState<Filter>({ action: "", source: "", container: "" });
  const [autoRefresh, setAutoRefresh] = useState(true);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["audit-history"],
    queryFn: () => fetchAuditHistory(500),
    refetchInterval: autoRefresh ? 5000 : false,
  });

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      refetch();
    }, 5000);
    return () => window.clearInterval(id);
  }, [autoRefresh, refetch]);

  const events = useMemo(() => applyFilter(data ?? [], filter), [data, filter]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Audit History</h1>
        <span className="text-sm text-muted-foreground">
          In-memory ring buffer; enable with <code>FIREFIK_AUDIT_SINK=…,history</code>.
        </span>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Action</span>
          <input
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded w-40"
            placeholder="apply / remove / drift…"
            value={filter.action}
            onChange={(e) => setFilter({ ...filter, action: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Source</span>
          <input
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded w-40"
            placeholder="api / event / drift…"
            value={filter.source}
            onChange={(e) => setFilter({ ...filter, source: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Container (id or name)</span>
          <input
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded w-60"
            value={filter.container}
            onChange={(e) => setFilter({ ...filter, container: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          <span>Auto-refresh (5s)</span>
        </label>
        <button
          onClick={() => refetch()}
          className="border px-3 py-1 rounded text-sm hover:bg-accent"
        >
          Refresh
        </button>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {error instanceof Error && <div className="text-sm text-red-600">Error: {error.message}</div>}

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-sm" aria-label="Audit history table">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-3 py-2">Time</th>
              {isPanelMode && <th className="text-left px-3 py-2">Agent</th>}
              <th className="text-left px-3 py-2">Action</th>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2">Container</th>
              <th className="text-left px-3 py-2">Rule-sets</th>
              <th className="text-left px-3 py-2">Default policy</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => (
              <tr key={`${ev.ts}-${i}`} className="border-t hover:bg-accent/30">
                <td className="px-3 py-1.5 whitespace-nowrap">{formatTime(ev.ts)}</td>
                {isPanelMode && (
                  <td className="px-3 py-1.5 font-mono text-xs">
                    {ev.agent_hostname || ev.agent_id || "—"}
                  </td>
                )}
                <td className="px-3 py-1.5">{ev.action}</td>
                <td className="px-3 py-1.5">{ev.source}</td>
                <td className="px-3 py-1.5">{ev.container_name || ev.container_id || "—"}</td>
                <td className="px-3 py-1.5">{ev.rule_sets ?? 0}</td>
                <td className="px-3 py-1.5">{ev.default_policy ?? "—"}</td>
              </tr>
            ))}
            {events.length === 0 && !isLoading && (
              <tr>
                <td
                  colSpan={isPanelMode ? 7 : 6}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No events.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-muted-foreground">
        Showing {events.length} of {data?.length ?? 0} events.
      </div>
    </div>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}
