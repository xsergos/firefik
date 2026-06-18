import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import type {
  FirewallRuleSetDTO,
  PolicySimulateResponse,
  PolicyValidateResponse,
} from "@/types/api";

const VALIDATE_DEBOUNCE_MS = 350;

const TEMPLATE_EXAMPLE = `# Paste or author a policy, hit "Save"
# Reference: docs/policies.md

policy "web-public" {
  allow if proto == "tcp" and port in [80, 443]
  block if geo in ["RU", "CN", "KP"]
  log   if port == 22
}
`;

export default function PoliciesPage() {
  const list = useQuery({
    queryKey: ["policies"],
    queryFn: () => fetchPolicies(),
    refetchInterval: 15_000,
  });

  const [selected, setSelected] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>("");
  const [buffer, setBuffer] = useState<string>(TEMPLATE_EXAMPLE);
  const [comment, setComment] = useState<string>("");
  const [containerID, setContainerID] = useState<string>("");
  const [validation, setValidation] = useState<PolicyValidateResponse | null>(null);
  const [simulation, setSimulation] = useState<PolicySimulateResponse | null>(null);
  const [busy, setBusy] = useState<"simulate" | "save" | null>(null);

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
  const effectiveName = useMemo(() => draftName || selected || "", [draftName, selected]);

  const onSimulate = async () => {
    if (!effectiveName) {
      toast.warning("Policy name required.");
      return;
    }
    setBusy("simulate");
    try {
      const res = await simulatePolicy(effectiveName, {
        dsl: buffer,
        containerID: containerID || undefined,
      });
      setSimulation(res);
    } catch (err) {
      const msg = err instanceof APIError ? err.userMessage : (err as Error).message;
      toast.error(`Simulate failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    if (!effectiveName) {
      toast.warning("Policy name required.");
      return;
    }
    setBusy("save");
    try {
      await savePolicy(effectiveName, buffer, comment);
      toast.success(`Saved ${effectiveName}`);
      setComment("");
      list.refetch();
    } catch (err) {
      const msg = err instanceof APIError ? err.userMessage : (err as Error).message;
      toast.error(`Save failed: ${msg}`);
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
  };

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Policies</h1>
        <span className="text-sm text-muted-foreground">
          Edit, simulate, save. Read-only mode via <code>FIREFIK_POLICIES_READONLY=true</code>.
        </span>
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
                v{p.version.slice(0, 10)} · {p.rules} rules
              </div>
            </button>
          ))}
        </aside>

        <section className="space-y-3">
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col gap-1 text-sm flex-1 min-w-[200px]">
              <span className="text-muted-foreground">Name</span>
              <input
                className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="web-public"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm flex-1 min-w-[200px]">
              <span className="text-muted-foreground">Container (for simulate)</span>
              <input
                className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded"
                value={containerID}
                onChange={(e) => setContainerID(e.target.value)}
                placeholder="12-hex prefix or full id"
              />
            </label>
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

          <div className="flex flex-wrap gap-2 items-center">
            <label className="flex flex-col gap-1 text-sm flex-1 min-w-[260px]">
              <span className="text-muted-foreground">Save comment (optional)</span>
              <input
                className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="why this change"
              />
            </label>
            <button
              onClick={onSimulate}
              disabled={busy !== null}
              className="border px-3 py-1.5 rounded text-sm hover:bg-accent"
            >
              {busy === "simulate" ? "Simulating…" : "Simulate"}
            </button>
            <button
              onClick={onSave}
              disabled={busy !== null || !shownValidation?.ok}
              className="bg-primary text-primary-foreground px-3 py-1.5 rounded text-sm disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>

          {simulation && <SimulatePanel sim={simulation} />}
        </section>
      </div>
    </div>
  );
}

function ValidationPanel({ validation }: { validation: PolicyValidateResponse | null }) {
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

function SimulatePanel({ sim }: { sim: PolicySimulateResponse }) {
  return (
    <div className="border rounded p-3 space-y-2 text-sm">
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium">Simulation: {sim.policy}</h3>
        {sim.container && (
          <span className="font-mono text-xs text-muted-foreground">{sim.container}</span>
        )}
      </div>
      {sim.defaultPolicy && (
        <p className="text-xs">
          <span className="text-muted-foreground">Default policy: </span>
          <code>{sim.defaultPolicy}</code>
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
        <p className="text-muted-foreground text-xs">No rule-sets compiled.</p>
      ) : (
        <ul className="space-y-1">
          {sim.ruleSets.map((rs, i) => (
            <li key={rs.name} className="border rounded p-2">
              <div className="flex justify-between">
                <span className="font-mono text-xs">
                  [{i}] {rs.name} ({rs.protocol ?? "tcp"})
                </span>
                {rs.log && <span className="text-xs text-amber-600">log</span>}
              </div>
              <RuleSetDetail rs={rs} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RuleSetDetail({ rs }: { rs: FirewallRuleSetDTO }) {
  const bits: string[] = [];
  if (rs.ports && rs.ports.length > 0) bits.push(`ports=${rs.ports.join(",")}`);
  if (rs.allowlist && rs.allowlist.length > 0) bits.push(`allow=${rs.allowlist.join(",")}`);
  if (rs.blocklist && rs.blocklist.length > 0) bits.push(`block=${rs.blocklist.join(",")}`);
  if (rs.geoAllow && rs.geoAllow.length > 0) bits.push(`geoAllow=${rs.geoAllow.join(",")}`);
  if (rs.geoBlock && rs.geoBlock.length > 0) bits.push(`geoBlock=${rs.geoBlock.join(",")}`);
  if (rs.rateLimit) bits.push(`rate=${rs.rateLimit.rate}/s burst ${rs.rateLimit.burst}`);
  if (bits.length === 0) return <p className="text-xs text-muted-foreground">(no constraints)</p>;
  return <p className="text-xs text-muted-foreground font-mono break-all">{bits.join(" · ")}</p>;
}
