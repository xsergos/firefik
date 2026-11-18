import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  FIREWALL_HINT,
  firewallLabel,
  unlistedPorts,
  type FirewallPendingState,
} from "@/lib/firewallState";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<string, string> = {
  active: "border-transparent bg-green-700 text-white",
  inactive:
    "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200",
  disabled: "border-border bg-transparent text-muted-foreground",
};

export function FirewallBadge({
  status,
  pending,
}: {
  status: string;
  pending?: FirewallPendingState | null;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge
        variant="outline"
        className={cn(STATUS_CLASS[status] ?? STATUS_CLASS.disabled)}
        title={FIREWALL_HINT[status]}
      >
        {firewallLabel(status)}
      </Badge>
      {pending === "unconfirmed" && (
        <Badge
          variant="outline"
          className="border-dashed border-border bg-transparent text-muted-foreground"
          title="The agent has not reported the new state yet. Check that it is online, then try again."
        >
          not confirmed
        </Badge>
      )}
      {(pending === "apply" || pending === "off") && (
        <Badge
          variant="outline"
          role="status"
          className="border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-200"
          title="Sent to the agent. The table updates when the agent reports the new state."
        >
          <Loader2 className="animate-spin" aria-hidden />
          {pending === "off" ? "turning off…" : "applying…"}
        </Badge>
      )}
    </span>
  );
}

const UNLISTED_CLASS: Record<string, string> = {
  DROP: "border-red-300 text-red-800 dark:border-red-500/40 dark:text-red-300",
  ACCEPT: "border-amber-300 text-amber-900 dark:border-amber-500/40 dark:text-amber-200",
};

export function UnlistedPortsBadge({ policy }: { policy: string | undefined }) {
  const info = unlistedPorts(policy);
  return (
    <Badge
      variant="outline"
      className={cn(UNLISTED_CLASS[info.policy])}
      title={`${info.hint} (${info.policy})`}
    >
      {info.label}
    </Badge>
  );
}
