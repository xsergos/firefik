import { Pause, Play, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ruleLabel } from "@/lib/flows";
import { plural } from "@/lib/firewallState";
import { cn } from "@/lib/utils";

export type LiveStreamStatus = "connecting" | "open" | "reconnecting";

const LIVE_STATUS_TEXT: Record<LiveStreamStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Disconnected, reconnecting…",
};

export function LiveStreamBar({
  status,
  paused,
  lineCount,
  newWhilePaused,
  canClear,
  onTogglePause,
  onClear,
}: {
  status: LiveStreamStatus;
  paused: boolean;
  lineCount: number;
  newWhilePaused: number;
  canClear: boolean;
  onTogglePause: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          status === "open" && !paused ? "bg-green-600" : "bg-muted-foreground/50",
        )}
        aria-hidden
      />
      <span role="status">{paused ? "Paused" : LIVE_STATUS_TEXT[status]}</span>
      {lineCount > 0 && <span>· {plural(lineCount, "line")}</span>}
      {newWhilePaused > 0 && <span>· {plural(newWhilePaused, "new line")} waiting</span>}
      <div className="ml-auto flex gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={onTogglePause}
          aria-pressed={paused}
          title={paused ? "Show new lines again" : "Stop the list from moving while you read"}
        >
          {paused ? <Play className="mr-1 h-3 w-3" /> : <Pause className="mr-1 h-3 w-3" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="outline" onClick={onClear} disabled={!canClear}>
          <Trash2 className="mr-1 h-3 w-3" />
          Clear
        </Button>
      </div>
    </div>
  );
}

export interface TrafficLine {
  at: string;
  level?: string;
  source?: string;
  line: string;
  fields?: Record<string, string>;
}

export function TrafficRow({ line }: { line: TrafficLine }) {
  const f = line.fields ?? {};
  const time = new Date(line.at).toLocaleTimeString();
  if (line.source === "nflog" && (f.srcIP || f.action)) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-3 leading-5">
        <span className="text-muted-foreground">{time}</span>
        {f.action && (
          <Badge
            variant={f.action === "DROP" ? "destructive" : "outline"}
            className="text-[10px] px-1.5 py-0"
          >
            {f.action}
          </Badge>
        )}
        {f.srcIP && <span>{f.srcIP}</span>}
        <span className="text-muted-foreground">→</span>
        {f.container && <span className="text-blue-600 dark:text-blue-400">{f.container}</span>}
        {f.dstPort && <span className="text-muted-foreground">:{f.dstPort}</span>}
        {f.proto && <span className="text-muted-foreground">{f.proto.toLowerCase()}</span>}
        {f.rule && <span className="text-muted-foreground">· {ruleLabel(f.rule)}</span>}
      </div>
    );
  }
  return (
    <div className="leading-5 break-all">
      <span className="text-muted-foreground">{time}</span>{" "}
      {line.level && <span className="text-muted-foreground">[{line.level}]</span>}{" "}
      {line.source && <span className="text-muted-foreground">{line.source}:</span>} {line.line}
    </div>
  );
}
