import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";

const PolicyEditor = lazy(() => import("./PolicyEditor"));
import {
  APIError,
  fetchPolicies,
  fetchPolicy,
  savePolicy,
  simulatePolicy,
  validatePolicy,
} from "@/lib/api";
import { createApproval } from "@/lib/controlPlaneApi";
import { whoami } from "@/lib/fleetApi";
import { isPanelMode } from "@/lib/panelMode";
import { useContainers } from "@/hooks/useContainers";
import { Button } from "@/components/ui/button";
import { UnlistedPortsBadge } from "@/components/shared/FirewallBadge";
import { cn } from "@/lib/utils";
import type {
  ContainerDTO,
  FirewallRuleSetDTO,
  PolicySimulateResponse,
  PolicyValidateResponse,
} from "@/types/api";

const VALIDATE_DEBOUNCE_MS = 350;
const INPUT_CLASS =
  "border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm";

const TEMPLATE_EXAMPLE = `# Paste or author a policy, hit "Save"
# Reference: docs/policies.md

policy "web-public" {
  allow if proto == "tcp" and port in [80, 443]
  block if geo in ["RU", "CN", "KP"]
  log   if port == 22
}
`;

const PANEL_REVIEW_NOTE =
  "It cannot be approved from this panel yet: everyone using the panel shares one operator identity. Approve it through the API with a different token. Approving does not apply the policy.";

const POLICY_NAME_RE = /^\s*policy\s+["']([^"'\n]+)["']/m;
const NAME_HELP = 'Type a name or start the text with policy "<name>".';

function policyNameFromDSL(dsl: string): string {
  return POLICY_NAME_RE.exec(dsl)?.[1]?.trim() ?? "";
}

function containerKey(c: ContainerDTO): string {
  return `${c.agent_id ?? ""}::${c.id}`;
}

function containerLabel(c: ContainerDTO): string {
  const agent = c.agent_id || c.agent_hostname;
  const name = c.name || c.id.slice(0, 12);
  return agent ? `${name} · ${agent}` : name;
}

function containerTitle(c: ContainerDTO): string {
  const parts = [`Container ID: ${c.id.slice(0, 12)}`];
  if (c.agent_hostname) parts.push(`Host: ${c.agent_hostname}`);
  return parts.join("\n");
}

function findSimulatedContainer(
  all: ContainerDTO[],
  chosen: ContainerDTO | undefined,
  simID: string | undefined,
): ContainerDTO | undefined {
  if (!simID) return undefined;
  const matches = (c: ContainerDTO) => c.id.startsWith(simID) || simID.startsWith(c.id);
  if (chosen && matches(chosen)) return chosen;
  return all.find(matches);
}

const CATCH_ALL = new Set(["0.0.0.0/0", "::/0"]);
const RULE_ACTION_RE = /#(allow|block|log)-\d+$/;

function ruleAction(rs: FirewallRuleSetDTO): string {
  const fromName = RULE_ACTION_RE.exec(rs.name)?.[1];
  if (fromName) return fromName;
  return rs.blocklist.some((b) => CATCH_ALL.has(b)) ? "block" : "allow";
}

function describeRuleSet(rs: FirewallRuleSetDTO): string {
  const action = ruleAction(rs);
  const parts = [action, rs.protocol || "tcp"];
  if (rs.ports.length === 0) parts.push("all ports");
  else parts.push(`${rs.ports.length === 1 ? "port" : "ports"} ${rs.ports.join(", ")}`);
  parts.push(rs.allowlist.length > 0 ? `from ${rs.allowlist.join(", ")}` : "from anywhere");
  const blocked = rs.blocklist.filter((b) => !CATCH_ALL.has(b));
  if (blocked.length > 0) parts.push(`except ${blocked.join(", ")}`);
  if (rs.geoAllow && rs.geoAllow.length > 0) parts.push(`only countries ${rs.geoAllow.join(", ")}`);
  if (rs.geoBlock && rs.geoBlock.length > 0)
    parts.push(`blocked countries ${rs.geoBlock.join(", ")}`);
  if (rs.rateLimit) parts.push(`limit ${rs.rateLimit.rate}/s, burst ${rs.rateLimit.burst}`);
  if (rs.log && action !== "log") parts.push("logged");
  return parts.join(" · ");
}

function errorMessage(err: unknown): string {
  return err instanceof APIError ? err.userMessage : (err as Error).message;
}

export default function PoliciesPage() {
  const list = useQuery({
    queryKey: ["policies"],
    queryFn: () => fetchPolicies(),
    refetchInterval: 15_000,
  });
  const containers = useContainers();
  const me = useQuery({ queryKey: ["whoami"], queryFn: whoami, retry: false });

  const [selected, setSelected] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>("");
  const [buffer, setBuffer] = useState<string>(TEMPLATE_EXAMPLE);
  const [comment, setComment] = useState<string>("");
  const [containerSearch, setContainerSearch] = useState<string>("");
  const [containerChoice, setContainerChoice] = useState<string>("");
  const [validation, setValidation] = useState<PolicyValidateResponse | null>(null);
  const [simulation, setSimulation] = useState<PolicySimulateResponse | null>(null);
  const [busy, setBusy] = useState<"simulate" | "save" | "review" | null>(null);
  const [sentForReview, setSentForReview] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    fetchPolicy(selected)
      .then((detail) => {
        if (cancelled) return;
        setDraftName(detail.name);
        setBuffer(detail.dsl);
      })
      .catch((err) => {
        if (!cancelled) toast.error(`Load policy failed: ${(err as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!buffer.trim()) {
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      validatePolicy(buffer)
        .then((out) => setValidation(out))
        .catch(() => setValidation(null));
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [buffer]);

  const shownValidation = buffer.trim() ? validation : null;
  const dslName = useMemo(() => policyNameFromDSL(buffer), [buffer]);
  const effectiveName = draftName.trim() || dslName || selected || "";

  const containerOptions = useMemo(() => {
    const all = containers.data ?? [];
    const needle = containerSearch.trim().toLowerCase();
    const matches = needle
      ? all.filter((c) =>
          [c.name, c.id, c.agent_hostname, c.agent_id].some((v) =>
            (v ?? "").toLowerCase().includes(needle),
          ),
        )
      : all;
    const chosen = all.find((c) => containerKey(c) === containerChoice);
    const withChosen = chosen && !matches.includes(chosen) ? [chosen, ...matches] : matches;
    return [...withChosen].sort((a, b) => containerLabel(a).localeCompare(containerLabel(b)));
  }, [containers.data, containerSearch, containerChoice]);
  const chosenContainer = (containers.data ?? []).find((c) => containerKey(c) === containerChoice);

  const requireName = (): boolean => {
    if (effectiveName) return true;
    toast.warning(`Policy name required. ${NAME_HELP}`);
    return false;
  };

  const onSimulate = async () => {
    if (!requireName()) return;
    setBusy("simulate");
    try {
      const res = await simulatePolicy(effectiveName, {
        dsl: buffer,
        containerID: chosenContainer?.id,
        agentID: chosenContainer?.agent_id,
      });
      setSimulation(res);
    } catch (err) {
      toast.error(`Simulate failed: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    if (!requireName()) return;
    setBusy("save");
    try {
      await savePolicy(effectiveName, buffer, comment);
      toast.success(`Saved ${effectiveName}`);
      setComment("");
      list.refetch();
    } catch (err) {
      toast.error(`Save failed: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onSendForReview = async () => {
    if (!requireName()) return;
    setBusy("review");
    try {
      await createApproval({
        policy_name: effectiveName,
        proposed_body: buffer,
        requester: me.data?.username ?? "",
      });
      setSentForReview(effectiveName);
      toast.success(`Sent ${effectiveName} for review`, {
        description: PANEL_REVIEW_NOTE,
      });
    } catch (err) {
      toast.error(`Send for review failed: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const onNew = () => {
    setSelected(null);
    setDraftName("");
    setBuffer(TEMPLATE_EXAMPLE);
    setComment("");
    setSimulation(null);
    setSentForReview(null);
  };

  const canSubmit = busy === null && !!shownValidation?.ok;
  const nameHint = draftName.trim()
    ? "Required."
    : dslName
      ? `Required. Using "${dslName}" from the policy text.`
      : `Required. ${NAME_HELP}`;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Policies</h1>
        <p className="text-sm text-muted-foreground">
          Write firewall rules once, test them against a container, and save them for reuse.
        </p>
        <p className="text-sm text-muted-foreground">
          {isPanelMode ? (
            <>
              Policies saved here are kept on the control plane and are not sent to agents yet. To
              enforce one, add its file to the agent&apos;s policies folder and give the container
              the label <code>firefik.policy=&lt;name&gt;</code>.
            </>
          ) : (
            <>
              To apply a saved policy, give the container the label{" "}
              <code>firefik.policy=&lt;name&gt;</code>.
            </>
          )}{" "}
          <Link to="/help/policies" className="underline">
            How this works
          </Link>
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
        <aside className="border rounded p-2 space-y-1 text-sm min-h-[200px]">
          <button
            onClick={onNew}
            className="w-full text-left px-2 py-1 rounded hover:bg-accent hover:text-accent-foreground"
          >
            + New policy
          </button>
          <hr className="my-2" />
          {list.isLoading && <p className="px-2 text-muted-foreground">Loading…</p>}
          {list.data?.length === 0 && (
            <p className="px-2 text-muted-foreground">No saved policies.</p>
          )}
          {list.data?.map((p) => (
            <button
              key={p.name}
              onClick={() => setSelected(p.name)}
              className={`w-full text-left px-2 py-1 rounded ${
                selected === p.name ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
              }`}
              title={p.source ?? ""}
            >
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground font-mono">
                v{p.version.slice(0, 10)} · {p.rules} {p.rules === 1 ? "rule" : "rules"}
              </div>
            </button>
          ))}
        </aside>

        <section className="space-y-3">
          <div className="flex flex-wrap gap-2 items-start">
            <div className="flex flex-col gap-1 text-sm flex-1 min-w-[200px]">
              <label htmlFor="policy-name" className="text-muted-foreground">
                Name{" "}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <input
                id="policy-name"
                className={INPUT_CLASS}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="e.g. web-public"
                required
                aria-required="true"
                aria-describedby="policy-name-hint"
              />
              <p id="policy-name-hint" className="text-xs text-muted-foreground">
                {nameHint}
              </p>
            </div>
            <div className="flex flex-col gap-1 text-sm flex-1 min-w-[240px]">
              <label htmlFor="policy-container" className="text-muted-foreground">
                Container to test against (optional)
              </label>
              <input
                type="search"
                className={INPUT_CLASS}
                value={containerSearch}
                onChange={(e) => setContainerSearch(e.target.value)}
                placeholder="Search by container or agent"
                aria-label="Search containers"
              />
              <select
                id="policy-container"
                className={INPUT_CLASS}
                value={containerChoice}
                onChange={(e) => setContainerChoice(e.target.value)}
              >
                <option value="">No container: check the policy text only</option>
                {containerOptions.map((c) => (
                  <option key={containerKey(c)} value={containerKey(c)} title={containerTitle(c)}>
                    {containerLabel(c)}
                  </option>
                ))}
              </select>
              {containers.isError && (
                <p className="text-xs text-destructive">Could not load containers.</p>
              )}
            </div>
          </div>

          <Suspense
            fallback={
              <div className="font-mono text-xs border rounded p-2 w-full min-h-[260px] text-muted-foreground">
                Loading editor…
              </div>
            }
          >
            <PolicyEditor
              value={buffer}
              onChange={(v) => setBuffer(v)}
              className="font-mono text-xs border rounded w-full min-h-[260px]"
            />
          </Suspense>

          <ValidationPanel validation={shownValidation} />

          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-col gap-1 text-sm flex-1 min-w-[260px]">
              <label htmlFor="policy-comment" className="text-muted-foreground">
                Save comment (optional)
              </label>
              <input
                id="policy-comment"
                className={INPUT_CLASS}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="why this change"
              />
            </div>
            <Button variant="outline" onClick={onSimulate} disabled={busy !== null}>
              {busy === "simulate" ? "Simulating…" : "Simulate"}
            </Button>
            <Button variant="outline" onClick={onSendForReview} disabled={!canSubmit}>
              {busy === "review" ? "Sending…" : "Send for review"}
            </Button>
            <Button onClick={onSave} disabled={!canSubmit}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          </div>

          {sentForReview && (
            <p className="text-sm text-muted-foreground" role="status">
              {sentForReview} is waiting for review. It cannot be approved from this panel yet.{" "}
              <Link to="/approvals" className="underline">
                Open Approvals
              </Link>
            </p>
          )}

          {simulation && (
            <SimulatePanel
              sim={simulation}
              container={findSimulatedContainer(
                containers.data ?? [],
                chosenContainer,
                simulation.container,
              )}
            />
          )}
        </section>
      </div>
    </div>
  );
}

export function ValidationPanel({ validation }: { validation: PolicyValidateResponse | null }) {
  if (!validation) return null;
  if (validation.ok && (!validation.warnings || validation.warnings.length === 0)) {
    return <p className="text-xs text-green-600">Syntax OK.</p>;
  }
  return (
    <div className="text-xs space-y-1">
      {validation.errors?.map((e, i) => (
        <div key={`e-${i}`} className="text-destructive">
          ✗ {e}
        </div>
      ))}
      {validation.warnings?.map((w, i) => (
        <div key={`w-${i}`} className="text-amber-600">
          ! {w}
        </div>
      ))}
    </div>
  );
}

function SimulatePanel({
  sim,
  container,
}: {
  sim: PolicySimulateResponse;
  container: ContainerDTO | undefined;
}) {
  return (
    <div className="border rounded p-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">Simulation: {sim.policy}</h3>
        {sim.container && (
          <span
            className="text-xs text-muted-foreground"
            title={container ? containerTitle(container) : `Container ID: ${sim.container}`}
          >
            Container:{" "}
            <span className={cn(!container?.name && "font-mono")}>
              {container ? containerLabel(container) : sim.container}
            </span>
          </span>
        )}
      </div>
      {sim.defaultPolicy && (
        <p className="text-xs flex items-center gap-2">
          <span className="text-muted-foreground">Ports not listed:</span>
          <UnlistedPortsBadge policy={sim.defaultPolicy} />
        </p>
      )}
      {sim.errors?.map((e, i) => (
        <div key={`se-${i}`} className="text-xs text-destructive">
          ✗ {e}
        </div>
      ))}
      {sim.warnings?.map((w, i) => (
        <div key={`sw-${i}`} className="text-xs text-amber-600">
          ! {w}
        </div>
      ))}
      {sim.ruleSets.length === 0 ? (
        <p className="text-muted-foreground text-xs">This policy produced no rules.</p>
      ) : (
        <ul className="space-y-1">
          {sim.ruleSets.map((rs) => (
            <li
              key={rs.name}
              className="border rounded px-2 py-1 text-xs break-words"
              title={`Rule ID: ${rs.name}`}
            >
              {describeRuleSet(rs)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
