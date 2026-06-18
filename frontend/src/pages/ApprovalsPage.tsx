import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchApprovals,
  approveApproval,
  rejectApproval,
  type PendingApproval,
} from "@/lib/controlPlaneApi";
import { queryKeys } from "@/lib/queryKeys";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableLoading, TableError } from "@/components/shared/TableStates";
import { toast } from "sonner";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  approved: "secondary",
  rejected: "destructive",
};

export default function ApprovalsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.approvals(statusFilter),
    queryFn: () => fetchApprovals(statusFilter),
    refetchInterval: 5_000,
  });

  const approve = useMutation({
    mutationFn: ({ id, approver }: { id: string; approver: string }) =>
      approveApproval(id, approver),
    onSuccess: () => {
      toast.success("Approval recorded");
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reject = useMutation({
    mutationFn: ({ id, approver, comment }: { id: string; approver: string; comment: string }) =>
      rejectApproval(id, approver, comment),
    onSuccess: () => {
      toast.info("Approval rejected");
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Policy approvals (4-eyes)</CardTitle>
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
            <p className="text-sm text-muted-foreground">No approvals match the selected status.</p>
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
}: {
  approval: PendingApproval;
  onApprove: (approver: string) => void;
  onReject: (approver: string, comment: string) => void;
  busy: boolean;
}) {
  const [approver, setApprover] = useState("");
  const [comment, setComment] = useState("");
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
          requested by <span className="font-mono">{approval.requester}</span> at{" "}
          {new Date(approval.requested_at).toLocaleString()}
        </span>
      </div>
      <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
        {approval.proposed_body}
      </pre>
      {approval.status === "pending" && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            placeholder="approver name"
            className="rounded border px-2 py-1 text-sm"
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
          />
          <input
            type="text"
            placeholder="rejection comment (optional)"
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
          {approval.status} by <span className="font-mono">{approval.approver}</span>
          {approval.approved_at ? ` at ${new Date(approval.approved_at).toLocaleString()}` : ""}
          {approval.rejection_comment ? ` — ${approval.rejection_comment}` : ""}
        </p>
      )}
    </div>
  );
}
