import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  APIError,
  applyContainerRules,
  bulkContainerActions,
  deactivateContainerRules,
} from "@/lib/api";
import { invalidateAfterMutation } from "@/lib/queryKeys";
import type { BulkAction, BulkResponse } from "@/types/api";

function surfaceError(action: string, err: unknown) {
  if (err instanceof APIError) {
    toast.error(`${action}: ${err.userMessage}`);
    console.debug(`${action} failed`, { status: err.status, code: err.code, details: err.details });
    return;
  }
  toast.error(`${action} failed.`);
  console.debug(`${action} failed`, err);
}

type ContainerActionVars = string | { id: string; agent_id?: string };

function unpackActionVars(v: ContainerActionVars): { id: string; agentID?: string } {
  if (typeof v === "string") return { id: v };
  return { id: v.id, agentID: v.agent_id };
}

export function useApplyContainer() {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, ContainerActionVars>({
    mutationFn: (v) => {
      const { id, agentID } = unpackActionVars(v);
      return applyContainerRules(id, agentID);
    },
    onSuccess: () => {
      for (const key of invalidateAfterMutation) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success("Firewall rules applied");
    },
    onError: (err: unknown) => surfaceError("Apply rules", err),
  });
}

export function useDeactivateContainer() {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, ContainerActionVars>({
    mutationFn: (v) => {
      const { id, agentID } = unpackActionVars(v);
      return deactivateContainerRules(id, agentID);
    },
    onSuccess: () => {
      for (const key of invalidateAfterMutation) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success("Firewall rules deactivated");
    },
    onError: (err: unknown) => surfaceError("Deactivate rules", err),
  });
}

type BulkActionWithAgent = BulkAction & { agent_id?: string };

export function useBulkContainers() {
  const queryClient = useQueryClient();

  return useMutation<BulkResponse, unknown, BulkActionWithAgent[]>({
    mutationFn: bulkContainerActions,
    onSuccess: (resp, actions) => {
      for (const key of invalidateAfterMutation) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      if (resp.summary.failed === 0) {
        toast.success(`Bulk: ${resp.summary.applied} applied, ${resp.summary.disabled} disabled`);
      } else {
        toast.warning(
          `Bulk: ${actions.length - resp.summary.failed}/${actions.length} succeeded (${resp.summary.failed} failed)`,
        );
      }
    },
    onError: (err: unknown) => surfaceError("Bulk update", err),
  });
}
