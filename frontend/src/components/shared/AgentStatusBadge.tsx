import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<string, string> = {
  healthy: "border-transparent bg-green-700 text-white",
  stale:
    "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200",
  dead: "border-transparent bg-red-700 text-white",
  unknown: "border-border bg-transparent text-foreground",
};

const STATUS_HINT: Record<string, string> = {
  healthy: "The agent reported in recently.",
  stale: "The agent has not reported for a while.",
  dead: "The agent has not reported for a long time.",
  unknown: "The agent has not reported yet.",
};

export function AgentStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(STATUS_CLASS[status] ?? STATUS_CLASS.unknown)}
      title={STATUS_HINT[status]}
    >
      {status}
    </Badge>
  );
}
