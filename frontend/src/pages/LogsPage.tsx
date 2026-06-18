import { useLogStream } from "@/hooks/useLogStream";
import { Badge } from "@/components/ui/badge";

export default function LogsPage() {
  const { logs: entries, connected } = useLogStream();

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Live Logs</h1>
        <Badge
          role="status"
          variant={connected ? "default" : "secondary"}
          className={connected ? "bg-green-500 hover:bg-green-600" : ""}
        >
          {connected ? "Connected" : "Disconnected"}
        </Badge>
      </div>

      <div className="flex-1 overflow-auto font-mono text-xs border rounded-md bg-muted/30 p-3 space-y-0.5">
        {entries.length === 0 && (
          <p className="text-muted-foreground">
            Waiting for firewall events… only rule sets with{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">log: true</code> emit NFLOG
            events (e.g. label{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              firefik.firewall.web.log=true
            </code>{" "}
            on a container).
          </p>
        )}
        {entries.map((entry) => (
          <div key={entry._id} className="flex gap-3 items-baseline leading-5">
            <span className="text-muted-foreground shrink-0">
              {new Date(entry.ts).toLocaleTimeString()}
            </span>
            {entry.action && (
              <Badge
                variant={entry.action === "DROP" ? "destructive" : "default"}
                className="shrink-0 text-[10px] px-1 py-0"
              >
                {entry.action}
              </Badge>
            )}
            {entry.srcIP && <span className="text-foreground shrink-0">{entry.srcIP}</span>}
            {entry.dstPort != null && (
              <span className="text-muted-foreground shrink-0">:{entry.dstPort}</span>
            )}
            {entry.container && <span className="text-blue-500 shrink-0">{entry.container}</span>}
            {entry.proto && <span className="text-muted-foreground">{entry.proto}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
