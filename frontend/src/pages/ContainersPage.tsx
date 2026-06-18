import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { useContainers } from "@/hooks/useContainers";
import {
  useApplyContainer,
  useBulkContainers,
  useDeactivateContainer,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableLoading, TableEmpty, TableError } from "@/components/shared/TableStates";
import type { ContainerDTO, FirewallRuleSetDTO } from "@/types/api";
import { containerToLabelsYaml, downloadTextFile } from "@/lib/containerYaml";
import { isPanelMode } from "@/lib/panelMode";

export default function ContainersPage() {
  const { t } = useTranslation();
  const { data: containers, isLoading, isFetching, isError } = useContainers();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<ContainerDTO | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulkDisable, setConfirmBulkDisable] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const apply = useApplyContainer();
  const deactivate = useDeactivateContainer();
  const bulk = useBulkContainers();

  const selected = selectedId ? (containers?.find((c) => c.id === selectedId) ?? null) : null;
  const setSelected = (ctr: ContainerDTO | null) => setSelectedId(ctr?.id ?? null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key !== "a" && e.key !== "d") return;
      const row = (document.activeElement as HTMLElement | null)?.closest?.(
        "tr[data-ctr-id]",
      ) as HTMLElement | null;
      if (!row) return;
      const id = row.getAttribute("data-ctr-id");
      if (!id) return;
      const ctr = containers?.find((c) => c.id === id);
      if (!ctr || ctr.firewallStatus === "disabled") return;
      if (applyingId !== null || deactivatingId !== null) return;
      e.preventDefault();
      if (e.key === "a") {
        setApplyingId(ctr.id);
        apply.mutate(
          { id: ctr.id, agent_id: ctr.agent_id },
          { onSettled: () => setApplyingId(null) },
        );
      } else if (ctr.firewallStatus === "active") {
        setConfirmDeactivate(ctr);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [containers, applyingId, deactivatingId, apply]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = useMemo(() => {
    if (!containers) return undefined;
    if (!filter.trim()) return containers;
    const needle = filter.toLowerCase();
    return containers.filter((c) => {
      if (c.name.toLowerCase().includes(needle)) return true;
      if (c.id.toLowerCase().includes(needle)) return true;
      if (c.status.toLowerCase().includes(needle)) return true;
      if (c.firewallStatus.toLowerCase().includes(needle)) return true;
      for (const [k, v] of Object.entries(c.labels ?? {})) {
        if (k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle)) return true;
      }
      return false;
    });
  }, [containers, filter]);

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

  const handleRowKey = (ctr: ContainerDTO) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelected(ctr);
    }
  };

  const selectableRows = (filtered ?? []).filter((c) => c.firewallStatus !== "disabled");
  const allVisibleSelected =
    selectableRows.length > 0 && selectableRows.every((c) => selectedIds.has(c.id));
  const selectedVisible = selectableRows.filter((c) => selectedIds.has(c.id));
  const bulkBusy = bulk.isPending;

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const c of selectableRows) next.delete(c.id);
        return next;
      }
      const next = new Set(prev);
      for (const c of selectableRows) next.add(c.id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const doBulkApply = () => {
    if (selectedVisible.length === 0) return;
    bulk.mutate(
      selectedVisible.map((c) => ({ id: c.id, action: "apply" as const, agent_id: c.agent_id })),
      { onSuccess: clearSelection },
    );
  };

  const doBulkDisable = () => {
    if (selectedVisible.length === 0) return;
    bulk.mutate(
      selectedVisible.map((c) => ({ id: c.id, action: "disable" as const, agent_id: c.agent_id })),
      {
        onSuccess: () => {
          clearSelection();
          setConfirmBulkDisable(false);
        },
        onError: () => setConfirmBulkDisable(false),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">{t("containers.title")}</h1>
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-0.5">
            <input
              ref={searchRef}
              type="search"
              placeholder={t("containers.filterPlaceholder")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm w-72"
              aria-label="Filter containers"
            />
            <span className="text-[10px] text-muted-foreground leading-tight">
              <kbd className="px-1 rounded bg-muted text-foreground font-mono">/</kbd> focus
              {" · "}
              <kbd className="px-1 rounded bg-muted text-foreground font-mono">a</kbd> apply
              {" · "}
              <kbd className="px-1 rounded bg-muted text-foreground font-mono">d</kbd> deactivate
            </span>
          </div>
          {filter && (
            <button
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setFilter("")}
              aria-label="Clear filter"
            >
              {t("containers.clearFilter")}
            </button>
          )}
        </div>
      </div>

      {selectedVisible.length > 0 && (
        <div className="flex items-center gap-2 rounded border bg-muted/40 px-3 py-2 text-sm">
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
            disabled={bulkBusy}
            onClick={() => setConfirmBulkDisable(true)}
            aria-label={t("containers.disableSelected")}
          >
            {t("containers.disableSelected")}
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
            <TableHead>Policy</TableHead>
            <TableHead>Rule sets</TableHead>
            <TableHead aria-label="Actions"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered?.length === 0 && (
            <TableEmpty
              colSpan={isPanelMode ? 9 : 8}
              label={filter ? `No containers match "${filter}".` : "No containers yet."}
            />
          )}
          {filtered?.map((ctr) => (
            <TableRow
              key={ctr.id}
              data-ctr-id={ctr.id}
              className="cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              role="button"
              tabIndex={0}
              aria-label={`Open details for ${ctr.name} (press a to apply, d to deactivate)`}
              onClick={() => setSelected(ctr)}
              onKeyDown={handleRowKey(ctr)}
            >
              <TableCell
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {ctr.firewallStatus !== "disabled" ? (
                  <input
                    type="checkbox"
                    aria-label={`Select ${ctr.name}`}
                    checked={selectedIds.has(ctr.id)}
                    onChange={() => toggleSelect(ctr.id)}
                  />
                ) : null}
              </TableCell>
              {isPanelMode && (
                <TableCell className="font-mono text-xs">
                  {ctr.agent_hostname || ctr.agent_id || "—"}
                </TableCell>
              )}
              <TableCell className="font-medium">{ctr.name}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{ctr.id}</TableCell>
              <TableCell>
                <Badge variant={ctr.status === "running" ? "default" : "secondary"}>
                  {ctr.status}
                </Badge>
              </TableCell>
              <TableCell>
                {ctr.firewallStatus === "active" && (
                  <Badge className="bg-green-500 hover:bg-green-600">Active</Badge>
                )}
                {ctr.firewallStatus === "inactive" && (
                  <Badge className="bg-yellow-500 hover:bg-yellow-600">Inactive</Badge>
                )}
                {ctr.firewallStatus === "disabled" && <Badge variant="outline">Disabled</Badge>}
              </TableCell>
              <TableCell>
                {ctr.firewallStatus !== "disabled" && (
                  <Badge variant="outline">{ctr.defaultPolicy ?? "RETURN"}</Badge>
                )}
              </TableCell>
              <TableCell>{ctr.ruleSets?.length ?? 0}</TableCell>
              <TableCell
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {ctr.firewallStatus !== "disabled" && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Re-apply rules for ${ctr.name}`}
                      disabled={applyingId !== null || deactivatingId !== null}
                      onClick={() => {
                        setApplyingId(ctr.id);
                        apply.mutate(
                          { id: ctr.id, agent_id: ctr.agent_id },
                          {
                            onSettled: () => setApplyingId(null),
                          },
                        );
                      }}
                    >
                      {applyingId === ctr.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Re-apply
                    </Button>
                    {ctr.firewallStatus === "active" && (
                      <Button
                        size="sm"
                        variant="destructive"
                        aria-label={`Deactivate firewall for ${ctr.name}`}
                        disabled={applyingId !== null || deactivatingId !== null}
                        onClick={() => setConfirmDeactivate(ctr)}
                      >
                        {deactivatingId === ctr.id && (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        )}
                        Deactivate
                      </Button>
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
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
          {selected && <ContainerDetail ctr={selected} />}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmBulkDisable} onOpenChange={() => setConfirmBulkDisable(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("containers.bulkDisableTitle", { count: selectedVisible.length })}
            </DialogTitle>
            <DialogDescription>{t("containers.bulkDisableBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmBulkDisable(false)}>
              {t("containers.cancel")}
            </Button>
            <Button variant="destructive" disabled={bulkBusy} onClick={doBulkDisable}>
              {bulkBusy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {t("containers.disableSelected")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDeactivate} onOpenChange={() => setConfirmDeactivate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate firewall?</DialogTitle>
            <DialogDescription>
              This removes all Firefik rules for
              <span className="font-semibold"> {confirmDeactivate?.name}</span>. Traffic
              restrictions will be dropped immediately. This cannot be undone automatically — to
              restore, press Re-apply.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeactivate(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!confirmDeactivate) return;
                const target = confirmDeactivate;
                setConfirmDeactivate(null);
                setDeactivatingId(target.id);
                deactivate.mutate(
                  { id: target.id, agent_id: target.agent_id },
                  {
                    onSettled: () => setDeactivatingId(null),
                  },
                );
              }}
            >
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContainerDetail({ ctr }: { ctr: ContainerDTO }) {
  const sets: FirewallRuleSetDTO[] = ctr.ruleSets ?? [];

  const handleExport = () => {
    const yaml = containerToLabelsYaml(ctr);
    downloadTextFile(yaml, `firefik-${ctr.name || ctr.id.slice(0, 12)}.yml`);
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">ID</span>
        <span className="font-mono">{ctr.id}</span>
        <span className="text-muted-foreground">Status</span>
        <span>{ctr.status}</span>
        <span className="text-muted-foreground">Default policy</span>
        <span>{ctr.defaultPolicy ?? "RETURN"}</span>
      </div>

      <Button size="sm" variant="outline" onClick={handleExport}>
        Export config as YAML
      </Button>

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
    </div>
  );
}
