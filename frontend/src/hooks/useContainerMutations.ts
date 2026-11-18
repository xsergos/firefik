import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  APIError,
  applyContainerRules,
  bulkContainerActions,
  deactivateContainerRules,
} from "@/lib/api";
import { invalidateAfterMutation } from "@/lib/queryKeys";
import { plural, type FirewallPending, type FirewallPendingState } from "@/lib/firewallState";
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

type ContainerActionVars = string | { id: string; agent_id?: string; name?: string };

function unpackActionVars(v: ContainerActionVars): { id: string; agentID?: string; name: string } {
  if (typeof v === "string") return { id: v, name: v };
  return { id: v.id, agentID: v.agent_id, name: v.name || v.id.slice(0, 12) };
}

export function applyToastMessage(name: string, agentID?: string): string {
  if (agentID) return `Sent to ${agentID}: applying rules to ${name}…`;
  return `Rules applied to ${name}`;
}

export function turnOffToastMessage(name: string, agentID?: string): string {
  if (agentID) return `Sent to ${agentID}: turning off the firewall for ${name}…`;
  return `Firewall turned off for ${name}`;
}

export function useApplyContainer() {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, ContainerActionVars>({
    mutationFn: (v) => {
      const { id, agentID } = unpackActionVars(v);
      return applyContainerRules(id, agentID);
    },
    onSuccess: (_data, v) => {
      for (const key of invalidateAfterMutation) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      const { name, agentID } = unpackActionVars(v);
      toast.success(applyToastMessage(name, agentID));
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
    onSuccess: (_data, v) => {
      for (const key of invalidateAfterMutation) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      const { name, agentID } = unpackActionVars(v);
      toast.success(turnOffToastMessage(name, agentID));
    },
    onError: (err: unknown) => surfaceError("Turn off firewall", err),
  });
}

type BulkActionWithAgent = BulkAction & { agent_id?: string };

function bulkSummary(applied: number, off: number, sent: boolean): string {
  const parts: string[] = [];
  if (applied > 0) {
    parts.push(
      sent
        ? `applying rules to ${plural(applied, "container")}`
        : `applied ${plural(applied, "container")}`,
    );
  }
  if (off > 0) {
    parts.push(
      sent ? `turning off ${plural(off, "container")}` : `turned off ${plural(off, "container")}`,
    );
  }
  return parts.join(" and ") || "nothing to do";
}

export function bulkToastMessage(actions: BulkActionWithAgent[], resp: BulkResponse): string {
  const agents = Array.from(new Set(actions.map((a) => a.agent_id).filter(Boolean)));
  const summary = bulkSummary(resp.summary.applied, resp.summary.disabled, agents.length > 0);
  if (agents.length === 0) return `Bulk: ${summary}`;
  const target = agents.length === 1 ? agents[0] : plural(agents.length, "agent");
  return `Sent to ${target}: ${summary}…`;
}

export function useBulkContainers() {
  const queryClient = useQueryClient();

  return useMutation<BulkResponse, unknown, BulkActionWithAgent[]>({
    mutationFn: bulkContainerActions,
    onSuccess: (resp, actions) => {
      for (const key of invalidateAfterMutation) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      if (resp.summary.failed === 0) {
        toast.success(bulkToastMessage(actions, resp));
      } else {
        toast.warning(
          `Bulk: ${actions.length - resp.summary.failed}/${actions.length} succeeded (${resp.summary.failed} failed)`,
        );
      }
    },
    onError: (err: unknown) => surfaceError("Bulk update", err),
  });
}

const PENDING_TIMEOUT_MS = 30_000;

type PendingEntry = { kind: FirewallPending; sentAt: number; expiredStatus?: string };

export type PendingTarget = { status: string; name: string; agentID?: string };

function reachedTarget(kind: FirewallPending, status: string): boolean {
  return kind === "off" ? status !== "active" : status === "active";
}

export function unconfirmedToastMessage(
  kind: FirewallPending,
  name: string,
  agentID?: string,
): string {
  const who = agentID || "Firefik";
  if (kind === "off") return `${who} has not confirmed that the firewall is off for ${name} yet`;
  return `${who} has not confirmed that rules are applied to ${name} yet`;
}

export function usePendingFirewall(
  dataUpdatedAt: number,
  lookup: (id: string) => PendingTarget | undefined,
) {
  const [entries, setEntries] = useState<ReadonlyMap<string, PendingEntry>>(() => new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latest = useRef({ dataUpdatedAt, lookup });

  useEffect(() => {
    latest.current = { dataUpdatedAt, lookup };
  });

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const clear = useCallback((ids: string[]) => {
    for (const id of ids) {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.delete(id);
    }
    setEntries((prev) => {
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const expire = useCallback(
    (id: string, kind: FirewallPending, sentAt: number) => {
      timers.current.delete(id);
      const { dataUpdatedAt: at, lookup: find } = latest.current;
      const target = find(id);
      if (!target || (reachedTarget(kind, target.status) && at >= sentAt)) {
        clear([id]);
        return;
      }
      setEntries((prev) => {
        const cur = prev.get(id);
        if (!cur || cur.sentAt !== sentAt) return prev;
        const next = new Map(prev);
        next.set(id, { ...cur, expiredStatus: target.status });
        return next;
      });
      toast.warning(unconfirmedToastMessage(kind, target.name, target.agentID), {
        description: "Check that the agent is online, then try again.",
      });
    },
    [clear],
  );

  const mark = useCallback(
    (ids: string[], kind: FirewallPending) => {
      const sentAt = Date.now();
      for (const id of ids) {
        const old = timers.current.get(id);
        if (old) clearTimeout(old);
        timers.current.set(
          id,
          setTimeout(() => expire(id, kind, sentAt), PENDING_TIMEOUT_MS),
        );
      }
      setEntries((prev) => {
        const next = new Map(prev);
        for (const id of ids) next.set(id, { kind, sentAt });
        return next;
      });
    },
    [expire],
  );

  const pendingFor = (id: string, status: string): FirewallPendingState | null => {
    const entry = entries.get(id);
    if (!entry) return null;
    if (entry.expiredStatus !== undefined) {
      return status === entry.expiredStatus ? "unconfirmed" : null;
    }
    if (reachedTarget(entry.kind, status) && dataUpdatedAt >= entry.sentAt) return null;
    return entry.kind;
  };

  return { mark, clear, pendingFor };
}
