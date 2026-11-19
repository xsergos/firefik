import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchRules } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { RuleEntry, FirewallRuleSetDTO } from "@/types/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableLoading, TableError } from "@/components/shared/TableStates";
import { UnlistedPortsBadge } from "@/components/shared/FirewallBadge";
import { UNLISTED_PORTS_HINT, containerHref } from "@/lib/firewallState";

const HOST_CONTAINER_ID = "(host)";
const HOST_STATUS = "host";
const LOCAL_AGENT_KEY = "__local__";

function isHostEntry(entry: RuleEntry): boolean {
  return entry.containerID === HOST_CONTAINER_ID || entry.status === HOST_STATUS;
}

function agentKey(entry: RuleEntry): string {
  return entry.agent_id || entry.agent_hostname || LOCAL_AGENT_KEY;
}

function agentLabel(entry: RuleEntry): string {
  return entry.agent_id || entry.agent_hostname || "local agent";
}

function agentHint(entry: RuleEntry): string | undefined {
  if (!entry.agent_hostname || entry.agent_hostname === entry.agent_id) return undefined;
  return `Host: ${entry.agent_hostname}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function groupSummary(group: AgentGroup): string {
  const containers = plural(group.containerEntries.length, "container", "containers");
  return group.hostEntries.length > 0 ? `Host firewall · ${containers}` : containers;
}

function hasFlags(rs: FirewallRuleSetDTO): boolean {
  return !!(rs.log || rs.rateLimit || rs.geoBlock?.length || rs.geoAllow?.length);
}

function containerLink(entry: RuleEntry): string {
  return containerHref(
    entry.agent_id || entry.agent_hostname,
    entry.containerName || entry.containerID,
  );
}

type AgentGroup = {
  key: string;
  label: string;
  hint?: string;
  agentID?: string;
  hostEntries: RuleEntry[];
  containerEntries: RuleEntry[];
};

function groupByAgent(entries: RuleEntry[]): AgentGroup[] {
  const map = new Map<string, AgentGroup>();
  for (const entry of entries) {
    const key = agentKey(entry);
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        label: agentLabel(entry),
        hint: agentHint(entry),
        agentID: entry.agent_id,
        hostEntries: [],
        containerEntries: [],
      };
      map.set(key, group);
    }
    if (isHostEntry(entry)) {
      group.hostEntries.push(entry);
    } else {
      group.containerEntries.push(entry);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function ruleSetMatchesPort(rs: FirewallRuleSetDTO, port: number): boolean {
  if (!rs.ports || rs.ports.length === 0) return false;
  return rs.ports.includes(port);
}

function ruleSetMatchesAddress(rs: FirewallRuleSetDTO, needle: string): boolean {
  const all = [...(rs.allowlist ?? []), ...(rs.blocklist ?? [])];
  return all.some((ip) => ip.toLowerCase().includes(needle));
}

type Filters = {
  text: string;
  port: string;
  address: string;
};

function filterEntries(entries: RuleEntry[], filters: Filters): RuleEntry[] {
  const text = filters.text.trim().toLowerCase();
  const portNum = filters.port.trim() === "" ? null : Number(filters.port.trim());
  const portValid =
    portNum !== null && Number.isFinite(portNum) && portNum >= 0 && portNum <= 65535;
  const address = filters.address.trim().toLowerCase();
  if (!text && !portValid && !address) return entries;

  return entries
    .map((entry) => {
      const hayParts = [
        entry.containerName,
        entry.containerID,
        entry.agent_hostname,
        entry.agent_id,
      ]
        .filter(Boolean)
        .map((s) => s!.toLowerCase());

      const matchesEntryText =
        !text ||
        hayParts.some((s) => s.includes(text)) ||
        entry.ruleSets.some((rs) => rs.name.toLowerCase().includes(text));

      if (!matchesEntryText) return null;

      const filteredSets = entry.ruleSets.filter((rs) => {
        if (portValid && !ruleSetMatchesPort(rs, portNum!)) return false;
        if (address && !ruleSetMatchesAddress(rs, address)) return false;
        return true;
      });

      const portFilterActive = portValid;
      const addressFilterActive = !!address;

      if ((portFilterActive || addressFilterActive) && filteredSets.length === 0) {
        return null;
      }

      if (portFilterActive || addressFilterActive) {
        return { ...entry, ruleSets: filteredSets };
      }
      return entry;
    })
    .filter((e): e is RuleEntry => e !== null);
}

export default function RulesPage() {
  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: queryKeys.rules(),
    queryFn: ({ signal }) => fetchRules({ signal }),
    refetchInterval: 15_000,
  });

  const [filters, setFilters] = useState<Filters>({ text: "", port: "", address: "" });
  const filterActive = filters.text !== "" || filters.port !== "" || filters.address !== "";

  const filtered = useMemo(() => filterEntries(data ?? [], filters), [data, filters]);
  const groups = useMemo(() => groupByAgent(filtered), [filtered]);

  return (
    <div className="space-y-6" aria-busy={isFetching}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Rules</h1>
          <p className="text-sm text-muted-foreground">
            The firewall rules each agent enforces right now, for the host and for its containers.
          </p>
        </div>
        <RuleFilters
          filters={filters}
          onChange={setFilters}
          onClear={() => setFilters({ text: "", port: "", address: "" })}
        />
      </div>
      {isLoading ? (
        <TableLoading label="Loading rules…" />
      ) : isError ? (
        <TableError label="Failed to load rules." />
      ) : !data || data.length === 0 ? (
        <p className="text-muted-foreground">
          No active firewall rules. Start a container with{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">firefik.enable=true</code>. See the{" "}
          <a
            className="underline"
            href="https://github.com/xsergos/firefik#docker-labels"
            target="_blank"
            rel="noopener noreferrer"
          >
            docs
          </a>{" "}
          for label reference.
        </p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground">No rules match the current filters.</p>
      ) : (
        groups.map((group) => (
          <AgentGroupCard key={group.key} group={group} filterActive={filterActive} />
        ))
      )}
    </div>
  );
}

function RuleFilters({
  filters,
  onChange,
  onClear,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  onClear: () => void;
}) {
  const active = filters.text !== "" || filters.port !== "" || filters.address !== "";
  const inputClass =
    "border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        placeholder="search host/container/name…"
        value={filters.text}
        onChange={(e) => onChange({ ...filters, text: e.target.value })}
        className={`${inputClass} w-72`}
        aria-label="Search rules"
      />
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={65535}
        placeholder="port"
        value={filters.port}
        onChange={(e) => onChange({ ...filters, port: e.target.value })}
        className={`${inputClass} w-24`}
        aria-label="Filter by port"
      />
      <input
        type="search"
        placeholder="address / CIDR"
        value={filters.address}
        onChange={(e) => onChange({ ...filters, address: e.target.value })}
        className={`${inputClass} w-44`}
        aria-label="Filter by address"
      />
      {active && (
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={onClear}
          aria-label="Clear filters"
        >
          clear
        </button>
      )}
    </div>
  );
}

function AgentGroupCard({ group, filterActive }: { group: AgentGroup; filterActive: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-3 text-base">
          {group.agentID ? (
            <Link
              to={`/fleet/${encodeURIComponent(group.agentID)}`}
              className="font-mono underline"
              title={group.hint}
            >
              {group.label}
            </Link>
          ) : (
            <span className="font-mono" title={group.hint}>
              {group.label}
            </span>
          )}
          <Badge variant="secondary" className="text-xs font-normal ml-auto">
            {groupSummary(group)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <AgentSection
          title="Host firewall"
          entries={group.hostEntries}
          emptyLabel={filterActive ? "No host rules match." : "No host rules."}
          isHost
        />
        <AgentSection
          title="Containers"
          entries={group.containerEntries}
          emptyLabel={filterActive ? "No container rules match." : "No containers with rules."}
          isHost={false}
        />
      </CardContent>
    </Card>
  );
}

function AgentSection({
  title,
  entries,
  emptyLabel,
  isHost,
}: {
  title: string;
  entries: RuleEntry[];
  emptyLabel: string;
  isHost: boolean;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground pl-1">{emptyLabel}</p>
      ) : (
        entries.map((entry) => (
          <EntryBlock
            key={`${entry.containerID}:${entry.containerName}`}
            entry={entry}
            isHost={isHost}
          />
        ))
      )}
    </div>
  );
}

function EntryBlock({ entry, isHost }: { entry: RuleEntry; isHost: boolean }) {
  const showFlags = entry.ruleSets.some(hasFlags);
  const title = entry.containerName || entry.containerID;
  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        {isHost ? (
          <span className="font-mono font-medium">{title}</span>
        ) : (
          <Link
            to={containerLink(entry)}
            className="font-mono font-medium underline"
            title="Open on the Containers page"
          >
            {title}
          </Link>
        )}
        {!isHost && (
          <Badge variant="outline" className="text-xs font-normal">
            {entry.containerID}
          </Badge>
        )}
        <span
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          title={UNLISTED_PORTS_HINT}
        >
          Unlisted ports
          <UnlistedPortsBadge policy={entry.defaultPolicy} />
        </span>
        {entry.status && (
          <Badge
            variant={entry.status === "running" ? "default" : "secondary"}
            className="ml-auto text-xs"
          >
            {entry.status}
          </Badge>
        )}
      </div>
      {entry.ruleSets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rule sets.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Ports</TableHead>
              <TableHead>Protocol</TableHead>
              <TableHead>Allowlist</TableHead>
              <TableHead>Blocklist</TableHead>
              <TableHead>Profile</TableHead>
              {showFlags && <TableHead>Flags</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entry.ruleSets.map((rs) => (
              <RuleSetRow key={rs.name} rs={rs} showFlags={showFlags} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function RuleSetRow({ rs, showFlags }: { rs: FirewallRuleSetDTO; showFlags: boolean }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{rs.name}</TableCell>
      <TableCell>
        {rs.ports?.length ? (
          rs.ports.join(", ")
        ) : (
          <span className="text-muted-foreground">any</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{(rs.protocol || "TCP").toUpperCase()}</Badge>
      </TableCell>
      <TableCell>
        <CIDRList items={rs.allowlist} />
      </TableCell>
      <TableCell>
        <CIDRList items={rs.blocklist} variant="destructive" />
      </TableCell>
      <TableCell>{rs.profile ? <Badge variant="secondary">{rs.profile}</Badge> : "—"}</TableCell>
      {showFlags && (
        <TableCell className="space-x-1">
          {rs.log && <Badge variant="outline">log</Badge>}
          {rs.rateLimit && <Badge variant="outline">{rs.rateLimit.rate}/s</Badge>}
          {rs.geoBlock && rs.geoBlock.length > 0 && (
            <Badge variant="destructive">block:{rs.geoBlock.join(",")}</Badge>
          )}
          {rs.geoAllow && rs.geoAllow.length > 0 && (
            <Badge variant="default">allow:{rs.geoAllow.join(",")}</Badge>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

function CIDRList({
  items,
  variant = "secondary",
}: {
  items?: string[];
  variant?: "secondary" | "destructive";
}) {
  const [expanded, setExpanded] = useState(false);
  if (!items || items.length === 0) return <span className="text-muted-foreground">—</span>;
  const collapsible = items.length > 3;
  const shown = collapsible && !expanded ? items.slice(0, 2) : items;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((ip) => (
        <Badge key={ip} variant={variant} className="font-mono text-xs">
          {ip}
        </Badge>
      ))}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "show less" : `+${items.length - 2} more`}
        </button>
      )}
    </div>
  );
}
