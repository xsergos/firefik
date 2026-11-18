import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { History, Loader2, ScrollText } from "lucide-react";
import { useContainers } from "@/hooks/useContainers";
import {
  useApplyContainer,
  useBulkContainers,
  useDeactivateContainer,
  usePendingFirewall,
} from "@/hooks/useContainerMutations";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableLoading, TableEmpty, TableError } from "@/components/shared/TableStates";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { FirewallBadge, UnlistedPortsBadge } from "@/components/shared/FirewallBadge";
import type { ContainerDTO, FirewallRuleSetDTO } from "@/types/api";
import { containerToLabelsYaml, downloadTextFile } from "@/lib/containerYaml";
import {
  IN_FLIGHT_HINT,
  NO_LABELS_HINT,
  UNLISTED_PORTS_HINT,
  canApplyFirewall,
  containerMatches,
  historyHref,
  isInFlight,
  plural,
  trafficHref,
  unlistedPorts,
  type FirewallPending,
  type FirewallPendingState,
} from "@/lib/firewallState";
import { isPanelMode } from "@/lib/panelMode";
import { cn } from "@/lib/utils";

type FirewallFilter = "all" | "active" | "inactive" | "disabled";

const FIREWALL_FILTERS: FirewallFilter[] = ["all", "active", "inactive", "disabled"];

const FILTER_LABEL: Record<FirewallFilter, string> = {
  all: "Any firewall",
  active: "Active",
  inactive: "Pending",
  disabled: "Off",
};

function agentKey(c: ContainerDTO): string {
  return c.agent_id || c.agent_hostname || "";
}

function agentLabel(c: ContainerDTO): string {
  return c.agent_id || c.agent_hostname || "—";
}

function agentHint(c: ContainerDTO): string | undefined {
  if (!c.agent_hostname || c.agent_hostname === c.agent_id) return undefined;
  return `Host: ${c.agent_hostname}`;
}

function canApply(c: ContainerDTO): boolean {
  return canApplyFirewall(c.firewallStatus, c.labels, c.enabled);
}

function startsGroup(prev: ContainerDTO | undefined, ctr: ContainerDTO): boolean {
  return prev === undefined || agentKey(prev) !== agentKey(ctr);
}

export default function ContainersPage() {
  const { t } = useTranslation();
  const { data: containers, isLoading, isFetching, isError, dataUpdatedAt } = useContainers();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<ContainerDTO | null>(null);
  const [params, setParams] = useSearchParams();
  const filter = params.get("name") ?? "";
  const exactName = params.get("exact") === "1";
  const agentFilter = params.get("agent") ?? "";
  const fwParam = params.get("firewall") as FirewallFilter | null;
  const firewallFilter: FirewallFilter =
    fwParam && FIREWALL_FILTERS.includes(fwParam) ? fwParam : "all";
  const runningOnly = params.get("running") === "1";
  const updateParam = (key: string, value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };
  const setFilter = (v: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v) next.set("name", v);
        else next.delete("name");
        next.delete("exact");
        return next;
      },
      { replace: true },
    );
  };
  const clearFilters = () => setParams(new URLSearchParams(), { replace: true });
  const hasFilters = !!(filter || agentFilter || firewallFilter !== "all" || runningOnly);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulkDisable, setConfirmBulkDisable] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const apply = useApplyContainer();
  const deactivate = useDeactivateContainer();
  const bulk = useBulkContainers();
  const pending = usePendingFirewall(dataUpdatedAt, (id) => {
    const c = containers?.find((x) => x.id === id);
    if (!c) return undefined;
    return { status: c.firewallStatus, name: c.name || c.id.slice(0, 12), agentID: c.agent_id };
  });

  const selected = selectedId ? (containers?.find((c) => c.id === selectedId) ?? null) : null;
  const setSelected = (ctr: ContainerDTO | null) => setSelectedId(ctr?.id ?? null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const agents = useMemo(() => {
    const seen = new Map<string, { label: string; hint?: string }>();
    for (const c of containers ?? []) {
      const key = agentKey(c);
      if (key && !seen.has(key)) seen.set(key, { label: agentLabel(c), hint: agentHint(c) });
    }
    return Array.from(seen, ([id, v]) => ({ id, ...v })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [containers]);

  const firewallCounts = useMemo(() => {
    const counts: Record<FirewallFilter, number> = { all: 0, active: 0, inactive: 0, disabled: 0 };
    for (const c of containers ?? []) {
      if (agentFilter && agentKey(c) !== agentFilter) continue;
      counts.all += 1;
      if (c.firewallStatus in counts) counts[c.firewallStatus as FirewallFilter] += 1;
    }
    return counts;
  }, [containers, agentFilter]);

  const filtered = useMemo(() => {
    if (!containers) return undefined;
    const needle = filter.trim().toLowerCase();
    const out = containers.filter(
      (c) =>
        (!agentFilter || agentKey(c) === agentFilter) &&
        (firewallFilter === "all" || c.firewallStatus === firewallFilter) &&
        (!runningOnly || c.status === "running") &&
        containerMatches(c, needle, exactName),
    );
    if (isPanelMode) {
      out.sort(
        (a, b) => agentLabel(a).localeCompare(agentLabel(b)) || a.name.localeCompare(b.name),
      );
    }
    return out;
  }, [containers, filter, exactName, agentFilter, firewallFilter, runningOnly]);

  const groupSizes = useMemo(() => {
    const sizes = new Map<string, number>();
    for (const c of filtered ?? []) sizes.set(agentKey(c), (sizes.get(agentKey(c)) ?? 0) + 1);
    return sizes;
  }, [filtered]);
  const showGroups = isPanelMode && !agentFilter && groupSizes.size > 1;

  if (isLoading)
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t("containers.title")}</h1>
        <TableLoading label="Loading containers…" />
      </div>
    );
  if (isError)
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t("containers.title")}</h1>
        <TableError label="Could not connect to backend. Make sure it is running." />
      </div>
    );

  const rowBusy = applyingId !== null || deactivatingId !== null;

  const runApply = (ctr: ContainerDTO) => {
    setApplyingId(ctr.id);
    pending.mark([ctr.id], "apply");
    apply.mutate(
      { id: ctr.id, agent_id: ctr.agent_id, name: ctr.name },
      {
        onSuccess: () => pending.mark([ctr.id], "apply"),
        onError: () => pending.clear([ctr.id]),
        onSettled: () => setApplyingId(null),
      },
    );
  };

  const runTurnOff = (ctr: ContainerDTO) => {
    setDeactivatingId(ctr.id);
    pending.mark([ctr.id], "off");
    deactivate.mutate(
      { id: ctr.id, agent_id: ctr.agent_id, name: ctr.name },
      {
        onSuccess: () => pending.mark([ctr.id], "off"),
        onError: () => pending.clear([ctr.id]),
        onSettled: () => setDeactivatingId(null),
      },
    );
  };

  const handleRowKey = (ctr: ContainerDTO) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelected(ctr);
      return;
    }
    if (rowBusy || isInFlight(pending.pendingFor(ctr.id, ctr.firewallStatus))) return;
    if (e.key === "a" && canApply(ctr)) {
      e.preventDefault();
      runApply(ctr);
    } else if (e.key === "d" && ctr.firewallStatus === "active") {
      e.preventDefault();
      setConfirmDeactivate(ctr);
    }
  };

  const selectableRows = (filtered ?? []).filter(canApply);
  const allVisibleSelected =
    selectableRows.length > 0 && selectableRows.every((c) => selectedIds.has(c.id));
  const selectedVisible = selectableRows.filter((c) => selectedIds.has(c.id));
  const selectedOn = selectedVisible.filter((c) => c.firewallStatus !== "disabled");
  const bulkBusy = bulk.isPending;

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const c of selectableRows) next.delete(c.id);
      } else {
        for (const c of selectableRows) next.add(c.id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const runBulk = (rows: ContainerDTO[], kind: FirewallPending, onDone?: () => void) => {
    if (rows.length === 0) return;
    const ids = rows.map((c) => c.id);
    pending.mark(ids, kind);
    bulk.mutate(
      rows.map((c) => ({
        id: c.id,
        action: kind === "off" ? ("disable" as const) : ("apply" as const),
        agent_id: c.agent_id,
      })),
      {
        onSuccess: (resp) => {
          const failed = resp.results.filter((r) => r.status === "error").map((r) => r.id);
          pending.mark(
            ids.filter((id) => !failed.includes(id)),
            kind,
          );
          pending.clear(failed);
          clearSelection();
          onDone?.();
        },
        onError: () => {
          pending.clear(ids);
          onDone?.();
        },
      },
    );
  };

  const doBulkApply = () => runBulk(selectedVisible, "apply");
  const doBulkDisable = () => runBulk(selectedOn, "off", () => setConfirmBulkDisable(false));

  const colSpan = isPanelMode ? 9 : 8;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">{t("containers.title")}</h1>
        <span className="text-sm text-muted-foreground tabular-nums">
          {filtered?.length ?? 0} of {containers?.length ?? 0}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isPanelMode && agents.length > 0 && (
          <select
            id="containers-agent"
            value={agentFilter}
            onChange={(e) => updateParam("agent", e.target.value)}
            aria-label="Filter by agent"
            className="border border-input bg-background text-foreground px-2 py-1 rounded text-sm max-w-full font-mono"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id} title={a.hint}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        <input
          id="containers-name"
          ref={searchRef}
          type="search"
          placeholder={t("containers.filterPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm w-64 max-w-full"
          aria-label="Filter containers"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by firewall">
          {FIREWALL_FILTERS.filter(
            (f) => f === "all" || firewallCounts[f] > 0 || f === firewallFilter,
          ).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={firewallFilter === f}
              onClick={() => updateParam("firewall", f === "all" ? "" : f)}
              className={cn(
                "rounded-full border px-3 py-0.5 text-xs",
                firewallFilter === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {FILTER_LABEL[f]} <span className="opacity-70 tabular-nums">{firewallCounts[f]}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            id="containers-running"
            type="checkbox"
            checked={runningOnly}
            onChange={(e) => updateParam("running", e.target.checked ? "1" : "")}
          />
          running only
        </label>
        {hasFilters && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground underline"
            onClick={clearFilters}
            aria-label="Clear filter"
          >
            {t("containers.clearFilter")}
          </button>
        )}
        <KeyboardHelp />
      </div>

      {selectedVisible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border bg-muted/40 px-3 py-2 text-sm">
          <span>{t("containers.selectedCount", { count: selectedVisible.length })}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkBusy}
            onClick={doBulkApply}
            aria-label={t("containers.applySelected")}
          >
            {bulkBusy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {t("containers.applySelected")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={bulkBusy || selectedOn.length === 0}
            onClick={() => setConfirmBulkDisable(true)}
            aria-label="Turn off selected"
            title={
              selectedOn.length === 0 ? "None of the selected containers are filtered" : undefined
            }
          >
            Turn off selected
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection} aria-label="Clear selection">
            {t("containers.clearSelection")}
          </Button>
        </div>
      )}

      <Table aria-busy={isFetching}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <input
                type="checkbox"
                aria-label={allVisibleSelected ? "Deselect all" : "Select all visible"}
                checked={allVisibleSelected}
                disabled={selectableRows.length === 0}
                onChange={toggleSelectAllVisible}
              />
            </TableHead>
            {isPanelMode && <TableHead>Agent</TableHead>}
            <TableHead>Name</TableHead>
            <TableHead>ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Firewall</TableHead>
            <TableHead title={UNLISTED_PORTS_HINT}>Unlisted ports</TableHead>
            <TableHead>Rule sets</TableHead>
            <TableHead aria-label="Actions"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered?.length === 0 && (
            <TableEmpty
              colSpan={colSpan}
              label={hasFilters ? "No containers match the current filters." : "No containers yet."}
            />
          )}
          {filtered?.map((ctr, i) => {
            const active = ctr.firewallStatus === "active";
            const applicable = canApply(ctr);
            const rowPending = pending.pendingFor(ctr.id, ctr.firewallStatus);
            const inFlight = isInFlight(rowPending);
            return (
              <Fragment key={ctr.id}>
                {showGroups && startsGroup(filtered[i - 1], ctr) && (
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell
                      colSpan={colSpan}
                      className="py-1.5 text-xs font-semibold text-muted-foreground"
                    >
                      <Link
                        to={`/fleet/${encodeURIComponent(agentKey(ctr))}`}
                        className="font-mono text-foreground underline"
                        title={agentHint(ctr)}
                      >
                        {agentLabel(ctr)}
                      </Link>
                      <span className="ml-2 tabular-nums">
                        {plural(groupSizes.get(agentKey(ctr)) ?? 0, "container")}
                      </span>
                      <button
                        type="button"
                        className="ml-3 underline hover:text-foreground"
                        onClick={() => updateParam("agent", agentKey(ctr))}
                      >
                        show only this agent
                      </button>
                    </TableCell>
                  </TableRow>
                )}
                <TableRow
                  data-ctr-id={ctr.id}
                  className="cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  role="button"
                  tabIndex={0}
                  aria-label={`Open details for ${ctr.name}`}
                  onClick={() => setSelected(ctr)}
                  onKeyDown={handleRowKey(ctr)}
                >
                  <TableCell
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {applicable ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${ctr.name}`}
                        checked={selectedIds.has(ctr.id)}
                        onChange={() => toggleSelect(ctr.id)}
                      />
                    ) : null}
                  </TableCell>
                  {isPanelMode && (
                    <TableCell
                      className="font-mono text-xs"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {agentKey(ctr) ? (
                        <Link
                          to={`/fleet/${encodeURIComponent(agentKey(ctr))}`}
                          className="underline"
                          title={agentHint(ctr)}
                        >
                          {agentLabel(ctr)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  )}
                  <TableCell className="font-medium">{ctr.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {ctr.id}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ctr.status === "running" ? "default" : "secondary"}>
                      {ctr.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <FirewallBadge status={ctr.firewallStatus} pending={rowPending} />
                  </TableCell>
                  <TableCell>
                    {ctr.firewallStatus !== "disabled" ? (
                      <UnlistedPortsBadge policy={ctr.defaultPolicy} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{ctr.ruleSets?.length ?? 0}</TableCell>
                  <TableCell
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <div className="flex gap-2">
                      {applicable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`${active ? "Re-apply" : "Apply"} rules for ${ctr.name}`}
                          title={inFlight ? IN_FLIGHT_HINT : undefined}
                          disabled={rowBusy || inFlight}
                          onClick={() => runApply(ctr)}
                        >
                          {applyingId === ctr.id && (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          )}
                          {active ? "Re-apply" : "Apply"}
                        </Button>
                      ) : (
                        <span title={NO_LABELS_HINT}>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Apply rules for ${ctr.name}: ${NO_LABELS_HINT}`}
                            disabled
                          >
                            Apply
                          </Button>
                        </span>
                      )}
                      {active && (
                        <Button
                          size="sm"
                          variant="destructive"
                          aria-label={`Turn off firewall for ${ctr.name}`}
                          title={inFlight ? IN_FLIGHT_HINT : undefined}
                          disabled={rowBusy || inFlight}
                          onClick={() => setConfirmDeactivate(ctr)}
                        >
                          {deactivatingId === ctr.id && (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          )}
                          Turn off
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("containers.detailDescription")}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <ContainerDetail
              ctr={selected}
              pending={pending.pendingFor(selected.id, selected.firewallStatus)}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmBulkDisable}
        onOpenChange={setConfirmBulkDisable}
        title={`Turn off the firewall for ${plural(selectedOn.length, "container")}?`}
        description="Firefik removes their rules and their traffic stops being filtered right away. Press Apply selected, or Apply on each row, to turn it back on."
        confirmLabel="Turn off selected"
        pending={bulkBusy}
        onConfirm={doBulkDisable}
      />

      <ConfirmDialog
        open={!!confirmDeactivate}
        onOpenChange={(open) => {
          if (!open) setConfirmDeactivate(null);
        }}
        title={`Turn off the firewall for ${confirmDeactivate?.name ?? ""}?`}
        description="Firefik removes this container's rules and its traffic stops being filtered right away. Press Apply to turn it back on."
        confirmLabel="Turn off"
        onConfirm={() => {
          if (!confirmDeactivate) return;
          const target = confirmDeactivate;
          setConfirmDeactivate(null);
          runTurnOff(target);
        }}
      />
    </div>
  );
}

function KeyboardHelp() {
  return (
    <details className="relative ml-auto text-xs">
      <summary className="cursor-pointer list-none rounded border px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        Keyboard shortcuts
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-64 space-y-1 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
        <p>
          <kbd className="px-1 rounded bg-muted font-mono">/</kbd> jump to the search box
        </p>
        <p>
          <kbd className="px-1 rounded bg-muted font-mono">Enter</kbd> open the focused container
        </p>
        <p>
          <kbd className="px-1 rounded bg-muted font-mono">a</kbd> apply rules to the focused
          container
        </p>
        <p>
          <kbd className="px-1 rounded bg-muted font-mono">d</kbd> turn off its firewall
        </p>
        <p className="text-muted-foreground">Use Tab to move between rows.</p>
      </div>
    </details>
  );
}

function ContainerDetail({
  ctr,
  pending,
}: {
  ctr: ContainerDTO;
  pending: FirewallPendingState | null;
}) {
  const sets: FirewallRuleSetDTO[] = ctr.ruleSets ?? [];
  const agentID = ctr.agent_id;
  const policy = unlistedPorts(ctr.defaultPolicy);
  const labels = Object.entries(ctr.labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const firefikLabels = labels.filter(([k]) => k.startsWith("firefik."));
  const otherLabels = labels.filter(([k]) => !k.startsWith("firefik."));
  const name = ctr.name || ctr.id.slice(0, 12);

  const handleExport = () => {
    const yaml = containerToLabelsYaml(ctr);
    downloadTextFile(yaml, `firefik-${name}.yml`);
  };

  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">Firewall</dt>
        <dd>
          <FirewallBadge status={ctr.firewallStatus} pending={pending} />
        </dd>
        {agentID && (
          <>
            <dt className="text-muted-foreground">Agent</dt>
            <dd>
              <Link to={`/fleet/${encodeURIComponent(agentID)}`} className="font-mono underline">
                {agentID}
              </Link>
              {ctr.agent_hostname && ctr.agent_hostname !== agentID && (
                <span className="text-muted-foreground"> on {ctr.agent_hostname}</span>
              )}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Status</dt>
        <dd>{ctr.status}</dd>
        <dt className="text-muted-foreground">ID</dt>
        <dd className="font-mono break-all">{ctr.id}</dd>
        <dt className="text-muted-foreground">Unlisted ports</dt>
        <dd>
          {ctr.firewallStatus === "disabled" ? (
            <span className="text-muted-foreground">Not filtered</span>
          ) : (
            <>
              <span>{policy.label}</span>{" "}
              <code className="rounded bg-muted px-1 text-xs">{policy.policy}</code>
              <p className="text-xs text-muted-foreground">{policy.hint}</p>
            </>
          )}
        </dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link to={trafficHref(agentID, ctr.name)}>
            <ScrollText className="mr-1 h-4 w-4" />
            Traffic for this container
          </Link>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to={historyHref(agentID, ctr.name)}>
            <History className="mr-1 h-4 w-4" />
            Change history
          </Link>
        </Button>
        <Button size="sm" variant="outline" onClick={handleExport}>
          Export config as YAML
        </Button>
      </div>

      {sets.length > 0 && (
        <div className="space-y-3">
          <p className="font-medium">Rule sets</p>
          {sets.map((rs) => (
            <div key={rs.name} className="border rounded p-3 space-y-1">
              <div className="flex items-center gap-2">
                <p className="font-semibold">{rs.name}</p>
                {rs.profile && <Badge variant="secondary">{rs.profile}</Badge>}
                {rs.protocol && <Badge variant="outline">{rs.protocol}</Badge>}
                {rs.log && <Badge variant="outline">log</Badge>}
              </div>
              <p>
                <span className="text-muted-foreground">Ports: </span>
                {rs.ports?.join(", ") || "—"}
              </p>
              {(rs.allowlist?.length ?? 0) > 0 && (
                <p>
                  <span className="text-muted-foreground">Allowlist: </span>
                  {rs.allowlist.join(", ")}
                </p>
              )}
              {(rs.blocklist?.length ?? 0) > 0 && (
                <p>
                  <span className="text-muted-foreground">Blocklist: </span>
                  {rs.blocklist.join(", ")}
                </p>
              )}
              {rs.rateLimit && (
                <p>
                  <span className="text-muted-foreground">Rate limit: </span>
                  {rs.rateLimit.rate}/s burst {rs.rateLimit.burst}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <p className="font-medium">Labels</p>
        {labels.length === 0 ? (
          <p className="text-muted-foreground">
            No labels. Add firefik labels to this container to protect it.
          </p>
        ) : (
          <>
            {firefikLabels.length === 0 ? (
              <p className="text-muted-foreground">
                No firefik labels. Add them to this container to protect it.
              </p>
            ) : (
              <LabelList labels={firefikLabels} strong />
            )}
            {otherLabels.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Other labels ({otherLabels.length})
                </summary>
                <div className="mt-1">
                  <LabelList labels={otherLabels} />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LabelList({ labels, strong = false }: { labels: [string, string][]; strong?: boolean }) {
  return (
    <ul className="max-h-40 space-y-0.5 overflow-auto rounded border p-2 font-mono text-xs">
      {labels.map(([k, v]) => (
        <li key={k} className="break-all">
          <span className={cn(strong ? "font-semibold text-foreground" : "text-muted-foreground")}>
            {k}
          </span>
          ={v}
        </li>
      ))}
    </ul>
  );
}
