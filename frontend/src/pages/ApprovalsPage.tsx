import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchApprovals,
  approveApproval,
  rejectApproval,
  type PendingApproval,
} from "@/lib/controlPlaneApi";
import { APIError } from "@/lib/api";
import { formatActor } from "@/lib/actor";
import { queryKeys } from "@/lib/queryKeys";
import { formatRelative } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableLoading, TableError } from "@/components/shared/TableStates";
import { EmptyState } from "@/components/shared/EmptyState";
import { toast } from "sonner";
import { Link } from "react-router-dom";

const OWN_REQUEST_NOTE =
  "This request came from the same operator identity as this panel, so it cannot be approved or rejected here. Use the API with a different token.";

function isSelfDecisionError(e: Error): boolean {
  return e instanceof APIError && e.status === 403;
}

function approvalErrorMessage(e: Error): string {
  if (e instanceof APIError) {
    if (e.status === 403) return "You cannot approve or reject a request you sent yourself.";
    return e.userMessage;
  }
  return e.message;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  approved: "secondary",
  rejected: "destructive",
};

export default function ApprovalsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.approvals(statusFilter),
    queryFn: () => fetchApprovals(statusFilter),
    refetchInterval: 5_000,
  });

  const onDecisionError = (e: Error, id: string) => {
    toast.error(approvalErrorMessage(e));
    if (!isSelfDecisionError(e)) return;
    const fp = data?.find((p) => p.id === id)?.requester_fingerprint;
    if (fp) setOwnFingerprint(fp);
  };

  const approve = useMutation({
    mutationFn: ({ id, approver }: { id: string; approver: string }) =>
      approveApproval(id, approver),
    onSuccess: () => {
      toast.success("Approval recorded");
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e: Error, vars) => onDecisionError(e, vars.id),
  });

  const reject = useMutation({
    mutationFn: ({ id, approver, comment }: { id: string; approver: string; comment: string }) =>
      rejectApproval(id, approver, comment),
    onSuccess: () => {
      toast.info("Approval rejected");
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e: Error, vars) => onDecisionError(e, vars.id),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Policy changes waiting for a second operator to check. Approving records a decision only;
          it does not save or apply the policy.
        </p>
        <p className="text-sm text-muted-foreground">
          Requests sent from this panel cannot be approved from this panel yet, because everyone
          using the panel shares one operator identity. Approve them through the API with a
          different token.{" "}
          <Link to="/help/approvals" className="underline">
            How this works
          </Link>
        </p>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Requests</CardTitle>
          <div className="flex gap-2">
            {["pending", "approved", "rejected", ""].map((s) => (
              <Button
                key={s || "all"}
                variant={statusFilter === s ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(s)}
              >
                {s || "all"}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && <TableLoading />}
          {isError && <TableError label={(error as Error).message} />}
          {!isLoading && !isError && (data ?? []).length === 0 && (
            <EmptyState title="No approvals match the selected status." helpAnchor="approvals">
              <p>
                Use <strong>Send for review</strong> on the{" "}
                <Link to="/policies" className="underline">
                  Policies
                </Link>{" "}
                page to ask for a second check of a policy change. A request waits here until a
                different operator identity approves or rejects it. Requests sent from this panel
                cannot be approved from this panel yet.
              </p>
            </EmptyState>
          )}
          {!isLoading && !isError && (data ?? []).length > 0 && (
            <div className="space-y-3">
              {(data as PendingApproval[]).map((p) => (
                <ApprovalCard
                  key={p.id}
                  approval={p}
                  onApprove={(approver) => approve.mutate({ id: p.id, approver })}
                  onReject={(approver, comment) => reject.mutate({ id: p.id, approver, comment })}
                  busy={approve.isPending || reject.isPending}
                  own={ownFingerprint !== null && p.requester_fingerprint === ownFingerprint}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ApprovalCard({
  approval,
  onApprove,
  onReject,
  busy,
  own,
}: {
  approval: PendingApproval;
  onApprove: (approver: string) => void;
  onReject: (approver: string, comment: string) => void;
  busy: boolean;
  own: boolean;
}) {
  const [approver, setApprover] = useState("");
  const [comment, setComment] = useState("");
  const requester = formatActor(approval.requester);
  const decidedBy = formatActor(approval.approver);
  return (
    <div className="rounded border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono">{approval.policy_name}</span>
          <Badge className="ml-2" variant={STATUS_VARIANT[approval.status]}>
            {approval.status}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          requested by <span title={requester.title}>{requester.label}</span>{" "}
          <span title={new Date(approval.requested_at).toLocaleString()}>
            {formatRelative(approval.requested_at)}
          </span>
        </span>
      </div>
      <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
        {approval.proposed_body}
      </pre>
      {approval.status === "pending" && own && (
        <p className="text-xs text-muted-foreground" role="note">
          {OWN_REQUEST_NOTE}
        </p>
      )}
      {approval.status === "pending" && !own && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            placeholder="approver name"
            aria-label="Your name"
            className="rounded border px-2 py-1 text-sm"
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
          />
          <input
            type="text"
            placeholder="rejection comment (optional)"
            aria-label="Rejection comment"
            className="flex-1 rounded border px-2 py-1 text-sm"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!approver.trim() || busy}
            onClick={() => onApprove(approver.trim())}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!approver.trim() || busy}
            onClick={() => onReject(approver.trim(), comment)}
          >
            Reject
          </Button>
        </div>
      )}
      {approval.status !== "pending" && approval.approver && (
        <p className="text-xs text-muted-foreground">
          {approval.status} by <span title={decidedBy.title}>{decidedBy.label}</span>
          {approval.approved_at ? (
            <span title={new Date(approval.approved_at).toLocaleString()}>
              {" "}
              {formatRelative(approval.approved_at)}
            </span>
          ) : (
            ""
          )}
          {approval.rejection_comment ? ` — ${approval.rejection_comment}` : ""}
        </p>
      )}
    </div>
  );
}
