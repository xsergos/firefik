export type FirewallPending = "apply" | "off";

export type FirewallPendingState = FirewallPending | "unconfirmed";

export function isInFlight(state: FirewallPendingState | null | undefined): boolean {
  return state === "apply" || state === "off";
}

export const IN_FLIGHT_HINT = "Waiting for the agent to report the new state";

export const FIREWALL_LABEL: Record<string, string> = {
  active: "Active",
  inactive: "Pending",
  disabled: "Off",
};

export const FIREWALL_HINT: Record<string, string> = {
  active: "Firefik rules are applied and this container's traffic is filtered.",
  inactive: "Firefik labels are set, but the rules are not applied yet. Press Apply.",
  disabled: "Firefik does not filter this container's traffic.",
};

export function firewallLabel(status: string): string {
  return FIREWALL_LABEL[status] ?? status;
}

export const FIREFIK_ENABLE_LABEL = "firefik.enable";

export const NO_LABELS_HINT = "Add firefik labels to this container first";

export function hasFirefikEnableLabel(labels: Record<string, string> | undefined): boolean {
  return labels?.[FIREFIK_ENABLE_LABEL] === "true";
}

export function canApplyFirewall(
  status: string,
  labels: Record<string, string> | undefined,
  enabled = false,
): boolean {
  return status !== "disabled" || enabled || hasFirefikEnableLabel(labels);
}

export const UNLISTED_PORTS_HINT =
  "What happens to traffic on ports that none of this container's rules mention.";

const UNLISTED_PORTS: Record<string, { label: string; hint: string }> = {
  DROP: {
    label: "Blocked",
    hint: "Traffic to ports without a rule is dropped.",
  },
  RETURN: {
    label: "Docker decides",
    hint: "Firefik leaves ports without a rule alone, so Docker's own rules decide.",
  },
  ACCEPT: {
    label: "Open",
    hint: "Traffic to ports without a rule is let through.",
  },
};

export function unlistedPorts(policy: string | undefined): {
  label: string;
  hint: string;
  policy: string;
} {
  const key = policy || "RETURN";
  const entry = UNLISTED_PORTS[key];
  if (!entry) return { label: key, hint: UNLISTED_PORTS_HINT, policy: key };
  return { ...entry, policy: key };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function containersHref(agentID: string | undefined, extra: Record<string, string> = {}) {
  const p = new URLSearchParams();
  if (agentID) p.set("agent", agentID);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const qs = p.toString();
  return qs ? `/containers?${qs}` : "/containers";
}

export function containerHref(agentID: string | undefined, name: string) {
  return containersHref(agentID, { name, exact: "1" });
}

export function containerMatches(
  c: { name: string; id: string; labels?: Record<string, string> },
  needle: string,
  exact = false,
): boolean {
  if (!needle) return true;
  const name = c.name.toLowerCase();
  const id = c.id.toLowerCase();
  if (exact) return name === needle || (needle.length >= 12 && id.startsWith(needle));
  if (name.includes(needle) || id.includes(needle)) return true;
  for (const [k, v] of Object.entries(c.labels ?? {})) {
    if (k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle)) return true;
  }
  return false;
}

export function trafficHref(agentID: string | undefined, container?: string, action?: string) {
  const p = new URLSearchParams();
  if (agentID) p.set("agent", agentID);
  if (container) p.set("container", container);
  if (action) p.set("action", action);
  const qs = p.toString();
  return qs ? `/logs?${qs}` : "/logs";
}

export function historyHref(agentID: string | undefined, search?: string) {
  const p = new URLSearchParams();
  if (agentID) p.set("agent", agentID);
  if (search) p.set("search", search);
  const qs = p.toString();
  return qs ? `/history?${qs}` : "/history";
}
