import type { AuditHistoryEvent } from "@/types/api";
import { formatActor, type ActorDisplay } from "@/lib/actor";

export type ChangeKind = "policies" | "containers" | "agents" | "tokens" | "approvals" | "other";

export const CHANGE_KINDS: { value: ChangeKind | ""; label: string }[] = [
  { value: "", label: "All changes" },
  { value: "policies", label: "Policies & templates" },
  { value: "containers", label: "Container rules" },
  { value: "agents", label: "Agents" },
  { value: "tokens", label: "Tokens" },
  { value: "approvals", label: "Approvals" },
  { value: "other", label: "Other" },
];

const KIND_BY_ACTION: Record<string, ChangeKind> = {
  policy_saved: "policies",
  policy_updated: "policies",
  template_published: "policies",
  container_firewall_applied: "containers",
  container_firewall_disabled: "containers",
  apply: "containers",
  remove: "containers",
  reconcile: "containers",
  drift_detected: "containers",
  drift: "containers",
  autogen_approved: "containers",
  autogen_rejected: "containers",
  agent_command: "agents",
  agent_deleted: "agents",
  agent_token_created: "tokens",
  agent_token_revoked: "tokens",
  enrollment_token_created: "tokens",
  token_rotated: "tokens",
  policy_approval_requested: "approvals",
  policy_approval_approved: "approvals",
  policy_approval_rejected: "approvals",
};

export function changeKind(action: string): ChangeKind {
  return KIND_BY_ACTION[action] ?? "other";
}

function meta(ev: AuditHistoryEvent, key: string): string {
  return ev.metadata?.[key] ?? "";
}

function ruleSets(ev: AuditHistoryEvent): string {
  if (ev.rule_sets != null) return String(ev.rule_sets);
  return meta(ev, "rule_sets");
}

function defaultPolicy(ev: AuditHistoryEvent): string {
  return ev.default_policy ?? meta(ev, "default_policy");
}

export function describeChange(ev: AuditHistoryEvent): string {
  switch (ev.action) {
    case "policy_saved": {
      const prev = meta(ev, "previous_version");
      const ver = meta(ev, "version");
      return prev ? `Policy saved ${prev} → ${ver}` : `Policy created ${ver}`;
    }
    case "policy_updated":
      return "Policy updated on agent";
    case "template_published":
      return `Template published v${meta(ev, "version")}`;
    case "container_firewall_applied":
      return "Firewall applied";
    case "container_firewall_disabled":
      return "Firewall disabled";
    case "apply": {
      const sets = ruleSets(ev);
      const pol = defaultPolicy(ev);
      const parts = [
        sets ? `${sets} ${sets === "1" ? "rule set" : "rule sets"}` : "",
        pol ? `default ${pol}` : "",
      ].filter(Boolean);
      return parts.length ? `Rules applied (${parts.join(", ")})` : "Rules applied";
    }
    case "remove":
      return "Rules removed";
    case "reconcile":
      return "Rules reconciled";
    case "drift":
    case "drift_detected":
      return "Drift detected";
    case "autogen_approved":
      return `Autogen proposal approved${meta(ev, "mode") ? ` as ${meta(ev, "mode")}` : ""}`;
    case "autogen_rejected":
      return "Autogen proposal rejected";
    case "agent_command":
      return `Command sent: ${meta(ev, "command") || "?"}`;
    case "agent_deleted":
      return "Agent removed";
    case "agent_token_created":
      return "Agent token issued";
    case "agent_token_revoked":
      return "Agent token revoked";
    case "enrollment_token_created":
      return "Enrollment token issued";
    case "token_rotated":
      return "API token rotated";
    case "policy_approval_requested":
      return "Approval requested";
    case "policy_approval_approved":
      return "Approval granted";
    case "policy_approval_rejected":
      return "Approval rejected";
  }
  const words = ev.action.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function containerShortId(ev: AuditHistoryEvent): string {
  return (ev.container_id || meta(ev, "container_id")).slice(0, 12);
}

function nonContainerTarget(ev: AuditHistoryEvent): string {
  return meta(ev, "policy_name") || meta(ev, "template");
}

function fallbackTarget(ev: AuditHistoryEvent): string {
  return meta(ev, "name") || meta(ev, "for_agent") || ev.agent_id || ev.agent_hostname || "";
}

export function changeTarget(ev: AuditHistoryEvent): string {
  return nonContainerTarget(ev) || ev.container_name || containerShortId(ev) || fallbackTarget(ev);
}

export interface TargetDisplay {
  label: string;
  secondary: string;
}

export function resolveTarget(
  ev: AuditHistoryEvent,
  containerNames?: ReadonlyMap<string, string>,
): TargetDisplay {
  const other = nonContainerTarget(ev);
  if (other) return { label: other, secondary: "" };
  const shortId = containerShortId(ev);
  if (ev.container_name) return { label: ev.container_name, secondary: shortId };
  if (shortId) {
    if (!containerNames) return { label: shortId, secondary: "" };
    const name = containerNames.get(shortId);
    if (name) return { label: name, secondary: shortId };
    return { label: `container ${shortId} (removed)`, secondary: "" };
  }
  return { label: fallbackTarget(ev), secondary: "" };
}

export function containerNameIndex(
  containers: readonly { id: string; name: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of containers) {
    const name = c.name.replace(/^\//, "");
    if (c.id && name) out.set(c.id.slice(0, 12), name);
  }
  return out;
}

export function changeActor(ev: AuditHistoryEvent): string {
  if (ev.actor) return ev.actor;
  if (ev.source === "control-plane" || ev.source === "panel") return "panel";
  return "agent";
}

export function actorDisplay(ev: AuditHistoryEvent): ActorDisplay {
  return actorKeyDisplay(changeActor(ev));
}

export function actorKeyDisplay(key: string): ActorDisplay {
  if (key === "panel") return { label: "Panel", title: "Done by the panel itself" };
  if (key === "agent") return { label: "Agent (automatic)", title: "Done by the agent on its own" };
  return formatActor(key);
}

export interface WhereInfo {
  label: string;
  description: string;
}

export const WHERE_LEGEND: WhereInfo[] = [
  { label: "panel", description: "Changed by someone in this panel." },
  {
    label: "control plane",
    description: "Sent from the panel to an agent, or recorded by the panel itself.",
  },
  {
    label: "agent API",
    description: "Changed through the agent's own API, for example by a script on that host.",
  },
  {
    label: "docker labels",
    description: "The agent read a container's firefik labels when it started, stopped or changed.",
  },
  {
    label: "drift check",
    description: "The agent found its firewall rules out of sync and put them back.",
  },
  { label: "startup", description: "The agent applied its rules when it started." },
  { label: "config reload", description: "The agent re-read its settings file." },
  { label: "schedule", description: "A rule with a time window switched on or off." },
  { label: "manual", description: "Changed by hand on the agent's host." },
];

const WHERE_BY_SOURCE: Record<string, string> = {
  panel: "panel",
  api: "agent API",
  event: "docker labels",
  label: "docker labels",
  drift: "drift check",
  "control-plane": "control plane",
  startup: "startup",
  "config-reload": "config reload",
  schedule: "schedule",
  manual: "manual",
};

export function changeWhere(ev: AuditHistoryEvent): string {
  return WHERE_BY_SOURCE[ev.source] ?? (ev.source || "—");
}

export function whereInfo(ev: AuditHistoryEvent): WhereInfo {
  const label = changeWhere(ev);
  const known = WHERE_LEGEND.find((w) => w.label === label);
  return known ?? { label, description: "" };
}

export function historyEventKey(ev: AuditHistoryEvent): string {
  return [ev.ts, ev.action, changeTarget(ev), ev.container_id ?? "", ev.agent_id ?? ""].join("|");
}

export function uniqueEventKeys(events: readonly AuditHistoryEvent[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const base = historyEventKey(events[i]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out[i] = n ? `${base}#${n}` : base;
  }
  return out;
}

export const REPEAT_WINDOW_MS = 60_000;

export interface HistoryGroup {
  head: AuditHistoryEvent;
  events: AuditHistoryEvent[];
}

function sameChange(a: AuditHistoryEvent, b: AuditHistoryEvent): boolean {
  return (
    a.action === b.action &&
    changeTarget(a) === changeTarget(b) &&
    (a.agent_id ?? "") === (b.agent_id ?? "") &&
    a.source === b.source &&
    (a.actor ?? "") === (b.actor ?? "")
  );
}

function withinWindow(a: AuditHistoryEvent, b: AuditHistoryEvent): boolean {
  const ta = Date.parse(a.ts);
  const tb = Date.parse(b.ts);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a.ts === b.ts;
  return Math.abs(ta - tb) <= REPEAT_WINDOW_MS;
}

export function groupRepeats(events: readonly AuditHistoryEvent[]): HistoryGroup[] {
  const out: HistoryGroup[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (last && sameChange(last.head, ev) && withinWindow(last.head, ev)) {
      last.events.push(ev);
    } else {
      out.push({ head: ev, events: [ev] });
    }
  }
  return out;
}

const HIDDEN_DETAIL_KEYS = new Set(["sha", "previous_sha"]);

export function detailEntries(ev: AuditHistoryEvent): [string, string][] {
  const out: [string, string][] = [];
  if (ev.container_id) out.push(["container_id", ev.container_id]);
  if (ev.container_ips?.length) out.push(["container_ips", ev.container_ips.join(", ")]);
  for (const [k, v] of Object.entries(ev.metadata ?? {})) {
    if (!HIDDEN_DETAIL_KEYS.has(k) && v) out.push([k, v]);
  }
  return out;
}
