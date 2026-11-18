import { useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TrafficRow, type TrafficLine } from "@/components/shared/TrafficRow";
import { plural } from "@/lib/firewallState";

type LogLine = TrafficLine & {
  agent: { instance_id: string; hostname: string };
};

type KeyedLine = LogLine & { _id: number };

type StreamStatus = "connecting" | "open" | "reconnecting";

const MAX_LINES = 500;
const BASE_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 30_000;

function wsURL(agentID: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/agents/${encodeURIComponent(agentID)}/logs`;
}

function reconnectDelay(attempt: number): number {
  return Math.min(BASE_RECONNECT_MS * 2 ** attempt, MAX_RECONNECT_MS) + Math.random() * 500;
}

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Disconnected, reconnecting…",
};

export function AgentLogsPanel({ agentID }: { agentID: string }) {
  const [lines, setLines] = useState<KeyedLine[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [activeAgent, setActiveAgent] = useState(agentID);
  const [frozen, setFrozen] = useState<KeyedLine[] | null>(null);
  const [pausedSeq, setPausedSeq] = useState(0);
  const seqRef = useRef(0);

  if (activeAgent !== agentID) {
    setActiveAgent(agentID);
    setStatus("connecting");
    setLines([]);
    setFrozen(null);
  }

  useEffect(() => {
    if (!agentID) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const sock = new WebSocket(wsURL(agentID));
      ws = sock;
      sock.onopen = () => {
        attempt = 0;
        setStatus("open");
      };
      sock.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as LogLine;
          if (parsed.fields?.event) return;
          seqRef.current += 1;
          const keyed: KeyedLine = { ...parsed, _id: seqRef.current };
          setLines((prev) => {
            const next = [keyed, ...prev];
            if (next.length > MAX_LINES) next.length = MAX_LINES;
            return next;
          });
        } catch {
          return;
        }
      };
      sock.onerror = () => sock.close();
      sock.onclose = () => {
        if (stopped || ws !== sock) return;
        ws = null;
        setStatus("reconnecting");
        timer = setTimeout(connect, reconnectDelay(attempt));
        attempt += 1;
      };
    };

    connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
    };
  }, [agentID]);

  const paused = frozen !== null;
  const shown = frozen ?? lines;
  const newWhilePaused = paused ? lines.filter((l) => l._id > pausedSeq).length : 0;

  const togglePause = () => {
    if (paused) {
      setFrozen(null);
      return;
    }
    setFrozen(lines);
    setPausedSeq(seqRef.current);
  };

  const clear = () => {
    setLines([]);
    if (paused) {
      setFrozen([]);
      setPausedSeq(seqRef.current);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className={
            status === "open" && !paused
              ? "inline-block h-2 w-2 rounded-full bg-green-600"
              : "inline-block h-2 w-2 rounded-full bg-muted-foreground/50"
          }
          aria-hidden
        />
        <span role="status">{paused ? "Paused" : STATUS_TEXT[status]}</span>
        {shown.length > 0 && <span>· {plural(shown.length, "line")}</span>}
        {shown.length >= MAX_LINES && <span>(only the newest {MAX_LINES} are kept)</span>}
        {newWhilePaused > 0 && <span>· {plural(newWhilePaused, "new line")} waiting</span>}
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={togglePause}
            aria-pressed={paused}
            title={paused ? "Show new lines again" : "Stop the list from moving while you read"}
          >
            {paused ? <Play className="mr-1 h-3 w-3" /> : <Pause className="mr-1 h-3 w-3" />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={clear}
            disabled={lines.length === 0 && shown.length === 0}
          >
            <Trash2 className="mr-1 h-3 w-3" />
            Clear
          </Button>
        </div>
      </div>
      <div className="rounded-lg border bg-muted/30 p-3 text-xs max-h-96 overflow-auto font-mono">
        {shown.length === 0 ? (
          <p className="font-sans text-sm text-muted-foreground">
            Waiting for traffic… dropped packets show up here as they happen.
          </p>
        ) : (
          shown.map((l) => <TrafficRow key={l._id} line={l} />)
        )}
      </div>
    </div>
  );
}
