import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { controlPlaneLogLineSchema, logStreamMessageSchema, type LogEntry } from "@/types/api";
import { wsLogsUrl } from "@/lib/api";

const MAX_ENTRIES = 1000;
const BASE_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 30_000;

export type KeyedLogEntry = LogEntry & { _id: number };

export function unwrapControlPlaneLine(parsed: unknown): unknown {
  const wrapped = controlPlaneLogLineSchema.safeParse(parsed);
  if (!wrapped.success) return parsed;
  const { agent, at, line } = wrapped.data;
  let inner: unknown;
  try {
    inner = JSON.parse(line);
  } catch {
    return { ts: at, raw: line, agent: agent.instance_id };
  }
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const obj = inner as Record<string, unknown>;
    if ("event" in obj) return obj;
    return { ts: at, ...obj, agent: agent.instance_id };
  }
  return { ts: at, raw: line, agent: agent.instance_id };
}

function nextDelay(attempt: number): number {
  const base = Math.min(BASE_RECONNECT_MS * 2 ** attempt, MAX_RECONNECT_MS);
  const jitter = Math.random() * 500;
  return base + jitter;
}

export function useLogStream(filter?: string) {
  const [logs, setLogs] = useState<KeyedLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const sessionRef = useRef(0);
  const attemptRef = useRef(0);

  useEffect(() => {
    sessionRef.current += 1;
    const session = sessionRef.current;
    const controller = new AbortController();

    function connect() {
      if (session !== sessionRef.current) return;

      const url = wsLogsUrl(filter);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (session !== sessionRef.current) return;
        setConnected(true);
        setError(null);
        attemptRef.current = 0;
        toast.dismiss("logstream-error");
      };

      ws.onmessage = (e: MessageEvent<string>) => {
        if (session !== sessionRef.current) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          console.warn("logstream: invalid JSON", e.data);
          return;
        }
        const result = logStreamMessageSchema.safeParse(unwrapControlPlaneLine(parsed));
        if (!result.success) {
          console.warn("logstream: schema mismatch", result.error.issues);
          return;
        }
        const msg = result.data;
        if ("event" in msg) {
          if (msg.event === "dropped") {
            toast.warning(`Log stream dropped ${msg.count} messages due to backpressure.`, {
              id: "logstream-dropped",
            });
          } else if (msg.event === "server_shutdown") {
            toast.info("Backend is shutting down. Reconnecting when available.", {
              id: "logstream-shutdown",
            });
          }
          return;
        }
        const keyed: KeyedLogEntry = { ...msg, _id: ++seqRef.current };
        setLogs((prev) => [keyed, ...prev].slice(0, MAX_ENTRIES));
      };

      ws.onclose = () => {
        if (session !== sessionRef.current) return;
        setConnected(false);
        const delay = nextDelay(attemptRef.current++);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        if (session !== sessionRef.current) return;
        const msg = "Log stream disconnected. Reconnecting…";
        setError(msg);
        toast.error(msg, { id: "logstream-error", duration: Infinity });
        ws.close();
      };
    }

    connect();

    controller.signal.addEventListener("abort", () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    });

    return () => {
      sessionRef.current += 1;
      controller.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [filter]);

  return { logs, connected, error };
}
