import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { approveAutogen, fetchAutogenProposals, rejectAutogen } from "@/lib/api";
import type { AutogenApproveResponse, AutogenProposal } from "@/types/api";

type StatusFilter = "all" | "pending" | "approved" | "rejected";

function confidenceBadgeClass(tier?: string): string {
  switch (tier) {
    case "high":
      return "bg-green-500 text-white";
    case "moderate":
      return "bg-amber-500 text-white";
    case "tentative":
      return "bg-sky-500 text-white";
    case "warming":
    default:
      return "bg-muted text-muted-foreground";
  }
}

export default function ProposalsPage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["autogen-proposals"],
    queryFn: () => fetchAutogenProposals(),
    refetchInterval: 10_000,
  });

  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [selected, setSelected] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<AutogenApproveResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const proposals = useMemo(() => {
    if (!data) return [] as AutogenProposal[];
    if (filter === "all") return data;
    return data.filter((p) => (p.status ?? "pending") === filter);
  }, [data, filter]);

  const active = useMemo(
    () => proposals.find((p) => p.container_id === selected) ?? proposals[0],
    [proposals, selected],
  );

  const onApprove = async (mode: "labels" | "policy") => {
    if (!active) return;
    setBusy(true);
    try {
      const res = await approveAutogen(active.container_id, mode, active.agent_id);
      setArtifact(res);
      toast.success(`Proposal approved as ${mode}. Copy the snippet below.`);
      await refetch();
    } catch (err) {
      toast.error(`Approve failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onReject = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await rejectAutogen(active.container_id, undefined, active.agent_id);
      toast.success("Proposal rejected.");
      setArtifact(null);
      await refetch();
    } catch (err) {
      toast.error(`Reject failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Autogen Proposals</h1>
        <span className="text-sm text-muted-foreground">
          Observe-mode learning. Enable with <code>FIREFIK_AUTOGEN_MODE=observe</code>.
        </span>
      </div>

      <div className="flex items-center gap-2">
        {(["pending", "approved", "rejected", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              setFilter(s);
              setSelected(null);
            }}
            className={`px-3 py-1 rounded text-sm ${
              filter === s ? "bg-primary text-primary-foreground" : "border hover:bg-accent"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading proposals…</p>}
      {proposals.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">No proposals in this bucket.</p>
      )}

      {proposals.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
          <ul className="border rounded max-h-[60vh] overflow-auto divide-y text-sm">
            {proposals.map((p) => (
              <li key={p.container_id}>
                <button
                  onClick={() => {
                    setSelected(p.container_id);
                    setArtifact(null);
                  }}
                  className={`w-full text-left px-3 py-2 ${
                    active?.container_id === p.container_id
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  }`}
                >
                  <div className="font-mono text-xs">{p.container_id.slice(0, 12)}</div>
                  {(p.agent_hostname || p.agent_id) && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {p.agent_hostname || p.agent_id}
                    </div>
                  )}
                  <div className="flex items-center gap-1 mt-1">
                    <span
                      className={`text-[10px] rounded px-1.5 py-0.5 ${confidenceBadgeClass(p.confidence)}`}
                    >
                      {p.confidence ?? "pending"}
                    </span>
                    <span className="text-[10px] rounded px-1.5 py-0.5 bg-muted">
                      {p.status ?? "pending"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {p.ports?.length ?? 0} ports · {p.peers?.length ?? 0} peers
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {active && (
            <section className="space-y-3 border rounded p-3">
              <div className="flex items-baseline justify-between">
                <h3 className="font-medium font-mono">{active.container_id}</h3>
                <span className="text-xs text-muted-foreground">
                  observed {active.observed_for ?? "?"}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Ports</p>
                  <p className="font-mono text-xs break-all">{active.ports?.join(", ") || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Peers</p>
                  <p className="font-mono text-xs break-all">{active.peers?.join(", ") || "—"}</p>
                </div>
              </div>

              {active.decided_by && (
                <p className="text-xs text-muted-foreground">
                  Last decision: <strong>{active.status}</strong> by {active.decided_by}
                  {active.decided_at ? ` at ${active.decided_at}` : null}
                  {active.reason ? ` (${active.reason})` : null}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => onApprove("labels")}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-sm bg-primary text-primary-foreground disabled:opacity-50"
                >
                  Approve → labels
                </button>
                <button
                  onClick={() => onApprove("policy")}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-sm border hover:bg-accent disabled:opacity-50"
                >
                  Approve → policy snippet
                </button>
                <button
                  onClick={onReject}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-sm text-destructive border border-destructive disabled:opacity-50"
                >
                  Reject
                </button>
              </div>

              {artifact && (
                <div className="border rounded p-2 bg-muted/40">
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-xs text-muted-foreground">
                      {artifact.mode === "labels" ? "docker-compose labels" : "policy DSL"} (paste
                      into your config)
                    </span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(artifact.snippet).then(
                          () => toast.success("Copied."),
                          () => toast.error("Copy failed."),
                        );
                      }}
                      className="text-xs underline"
                    >
                      copy
                    </button>
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap">{artifact.snippet}</pre>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
