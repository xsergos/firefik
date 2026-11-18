import { useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AgentStatusBadge } from "@/components/shared/AgentStatusBadge";
import { toast } from "sonner";
import { createEnrollmentToken, fetchPanelConfig, type EnrollmentToken } from "@/lib/fleetApi";
import { isValidInstanceID, isValidHTTPURL, isValidGRPCEndpoint } from "@/lib/enrollValidators";

const DEFAULT_CP_HTTP = "https://cp.example.com:8443";
const DEFAULT_CP_GRPC = "cp.example.com:8444";
const DEFAULT_TTL_MINUTES = 15;
const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 1440;
const CLOCK_TICK_MS = 15_000;
const STORAGE_KEY = "firefik.addAgent.endpoints";
const INPUT_CLASS =
  "border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm w-full font-mono";
const LOCALHOST_WARNING =
  "A remote host cannot reach localhost. Use an address the new host can reach.";

let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, CLOCK_TICK_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function getClockNow(): number {
  return clockNow;
}

function useTickingNow(): number {
  return useSyncExternalStore(subscribeClock, getClockNow, getClockNow);
}

function readStoredEndpoints(): { http?: string; grpc?: string } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { http?: string; grpc?: string }) : {};
  } catch {
    return {};
  }
}

function storeEndpoints(http: string, grpc: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ http, grpc }));
  } catch {
    return;
  }
}

function parseTTL(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= MIN_TTL_MINUTES && n <= MAX_TTL_MINUTES ? n : null;
}

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

function httpHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function grpcHost(endpoint: string): string {
  const colon = endpoint.lastIndexOf(":");
  return colon > 0 ? endpoint.slice(0, colon) : endpoint;
}

export default function AddAgentPage() {
  const [instanceID, setInstanceID] = useState("host-01");
  const [stored] = useState(readStoredEndpoints);
  const [httpOverride, setCpHTTP] = useState<string | null>(null);
  const [grpcOverride, setCpGRPC] = useState<string | null>(null);
  const panelConfig = useQuery({
    queryKey: ["panel-config"],
    queryFn: fetchPanelConfig,
    retry: false,
    staleTime: Infinity,
  });
  const cpHTTP = httpOverride ?? (panelConfig.data?.enroll_url || stored.http || DEFAULT_CP_HTTP);
  const cpGRPC =
    grpcOverride ?? (panelConfig.data?.grpc_endpoint || stored.grpc || DEFAULT_CP_GRPC);
  const [ttlRaw, setTtlRaw] = useState(String(DEFAULT_TTL_MINUTES));
  const [ttlTouched, setTtlTouched] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const now = useTickingNow();

  const ttlMinutes = parseTTL(ttlRaw);
  const validInstance = isValidInstanceID(instanceID);
  const validHTTP = isValidHTTPURL(cpHTTP);
  const validGRPC = isValidGRPCEndpoint(cpGRPC);
  const valid = validInstance && validHTTP && validGRPC && ttlMinutes !== null;
  const httpIsLocal = validHTTP && isLocalHost(httpHost(cpHTTP));
  const grpcIsLocal = validGRPC && isLocalHost(grpcHost(cpGRPC));

  const create = useMutation({
    mutationFn: () => createEnrollmentToken(instanceID, (ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60),
    onSuccess: (tok) => {
      setIssued({ ...tok, receivedAt: Date.now() });
      storeEndpoints(cpHTTP, cpGRPC);
      toast.success("Enrollment token created");
    },
    onError: (e: Error) => toast.error(`Token creation failed: ${e.message}`),
  });

  const oneLiner = useMemo(() => {
    if (!issued) return "";
    return [
      `curl -fsSL "${cpHTTP}/v1/enroll" \\`,
      `    -X POST -H 'Content-Type: application/json' \\`,
      `    -d '${JSON.stringify({ agent_id: instanceID, enrollment_token: issued.token })}' \\`,
      `    > /tmp/firefik-enroll.json && \\`,
      `mkdir -p /etc/firefik && \\`,
      `jq -r .cert_pem /tmp/firefik-enroll.json > /etc/firefik/cert.pem && \\`,
      `jq -r .key_pem  /tmp/firefik-enroll.json > /etc/firefik/key.pem  && \\`,
      `jq -r .bundle_pem /tmp/firefik-enroll.json > /etc/firefik/bundle.pem && \\`,
      `chmod 600 /etc/firefik/key.pem && \\`,
      `rm /tmp/firefik-enroll.json && \\`,
      `echo "Enrolled host: ${instanceID}"`,
    ].join("\n");
  }, [issued, cpHTTP, instanceID]);

  const composeSnippet = useMemo(() => {
    return `# /etc/firefik/docker-compose.yml on the new host
services:
  firefik-back:
    image: ghcr.io/xsergos/firefik-backend:latest
    network_mode: host
    cap_add: [NET_ADMIN, NET_RAW]
    cap_drop: [ALL]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /etc/firefik:/etc/firefik:ro
    environment:
      FIREFIK_INSTANCE_ID: ${instanceID}
      FIREFIK_CONTROL_PLANE_GRPC: ${cpGRPC}
      FIREFIK_CONTROL_PLANE_CA_CERT: /etc/firefik/bundle.pem
      FIREFIK_CONTROL_PLANE_CLIENT_CERT: /etc/firefik/cert.pem
      FIREFIK_CONTROL_PLANE_CLIENT_KEY: /etc/firefik/key.pem`;
  }, [instanceID, cpGRPC]);

  const copy = (text: string, label: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${label} copied`))
      .catch(() => toast.error("clipboard write failed"));
  };

  const expiresIn = formatExpiresIn(issued, now);

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link to="/fleet" className="text-sm text-muted-foreground underline">
          ← Fleet
        </Link>
        <h1 className="text-2xl font-bold">Add agent</h1>
      </div>

      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Create a one-time code, run two snippets on the new host, and it joins the fleet. The code
          works once and expires after the time you choose.
        </p>
        <p>
          Before you start, the new host needs a root shell, <code>curl</code>, <code>jq</code>, and
          Docker with Compose.
        </p>
        <p>
          Cannot use one-time enrollment on this host? Issue a long-lived token on{" "}
          <Link to="/agent-tokens" className="underline">
            Agent tokens
          </Link>{" "}
          instead.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field id="add-agent-instance" label="Instance ID" hint="Lowercase name, e.g. host-prod-01">
          <input
            id="add-agent-instance"
            aria-describedby="add-agent-instance-hint"
            value={instanceID}
            onChange={(e) => {
              setInstanceID(e.target.value.trim());
              setIssued(null);
            }}
            className={INPUT_CLASS}
          />
          {!validInstance && (
            <span className="text-xs text-destructive">Must match [a-z0-9-]{`{3,63}`}</span>
          )}
        </Field>

        <Field
          id="add-agent-ttl"
          label="Code expires after (minutes)"
          hint={`Single-use; ${MIN_TTL_MINUTES}–${MAX_TTL_MINUTES}`}
        >
          <input
            id="add-agent-ttl"
            aria-describedby="add-agent-ttl-hint"
            type="number"
            inputMode="numeric"
            min={MIN_TTL_MINUTES}
            max={MAX_TTL_MINUTES}
            value={ttlRaw}
            aria-invalid={ttlTouched && ttlMinutes === null}
            onChange={(e) => setTtlRaw(e.target.value)}
            onBlur={() => {
              setTtlTouched(true);
              if (ttlMinutes !== null) setTtlRaw(String(ttlMinutes));
            }}
            className={INPUT_CLASS}
          />
          {ttlTouched && ttlMinutes === null && (
            <span className="text-xs text-destructive">
              Enter a whole number of minutes from {MIN_TTL_MINUTES} to {MAX_TTL_MINUTES}.
            </span>
          )}
        </Field>

        <Field
          id="add-agent-http"
          label="Enrollment address"
          hint="Address the new host uses to fetch its certificate (may differ from this panel's address)"
        >
          <input
            id="add-agent-http"
            aria-describedby="add-agent-http-hint"
            value={cpHTTP}
            onChange={(e) => setCpHTTP(e.target.value.trim())}
            className={INPUT_CLASS}
          />
          {!validHTTP && (
            <span className="text-xs text-destructive">
              Must be https://host[:port][/path] (no shell-special chars)
            </span>
          )}
          {httpIsLocal && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              {LOCALHOST_WARNING}
            </span>
          )}
        </Field>

        <Field
          id="add-agent-grpc"
          label="Agent connection address"
          hint="host:port the agent keeps connected to"
        >
          <input
            id="add-agent-grpc"
            aria-describedby="add-agent-grpc-hint"
            value={cpGRPC}
            onChange={(e) => setCpGRPC(e.target.value.trim())}
            className={INPUT_CLASS}
          />
          {!validGRPC && (
            <span className="text-xs text-destructive">
              Must be host:port (DNS / IP, port 1–65535)
            </span>
          )}
          {grpcIsLocal && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              {LOCALHOST_WARNING}
            </span>
          )}
        </Field>
      </div>

      <div className="flex gap-2 items-center">
        <Button disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Generating…" : issued ? "Generate new token" : "Generate token"}
        </Button>
        {issued && (
          <span className="text-sm text-muted-foreground" aria-live="polite">
            token:{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              {issued.token.slice(0, 12)}…
            </code>{" "}
            • {expiresIn === "expired" ? "expired" : `expires in ${expiresIn}`}
          </span>
        )}
      </div>

      {issued && (
        <>
          <Section
            title="Step 1 — Run on the new host (root)"
            action={
              <Button size="sm" variant="outline" onClick={() => copy(oneLiner, "Bash one-liner")}>
                Copy
              </Button>
            }
          >
            <pre className="bg-muted rounded p-3 text-xs overflow-auto font-mono whitespace-pre">
              {oneLiner}
            </pre>
          </Section>

          <Section
            title="Step 2 — Boot the agent container"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => copy(composeSnippet, "Compose snippet")}
              >
                Copy
              </Button>
            }
          >
            <pre className="bg-muted rounded p-3 text-xs overflow-auto font-mono whitespace-pre">
              {composeSnippet}
            </pre>
          </Section>

          <Section title="What happens next">
            <ul className="text-sm space-y-1 list-disc pl-5">
              <li>
                Step 1 uses up the code and saves the host&apos;s certificate and key in{" "}
                <code>/etc/firefik/</code>.
              </li>
              <li>Step 2 starts the agent, which connects to the control plane by itself.</li>
              <li>
                The new host appears on the{" "}
                <Link to="/fleet" className="underline">
                  Fleet
                </Link>{" "}
                page within about 30 seconds, with one of these statuses:{" "}
                <AgentStatusBadge status="healthy" /> <AgentStatusBadge status="stale" />{" "}
                <AgentStatusBadge status="dead" />.
              </li>
              <li>The code expires on its own; generate a new one here if needed.</li>
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

type IssuedToken = EnrollmentToken & { receivedAt: number };

function formatExpiresIn(issued: IssuedToken | null, now: number): string {
  if (!issued) return "";
  const expires = new Date(issued.expires_at).getTime();
  const serverLifetime = expires - new Date(issued.issued_at).getTime();
  const lifetime = Number.isFinite(serverLifetime) ? serverLifetime : expires - issued.receivedAt;
  const ms = lifetime - Math.max(0, now - issued.receivedAt);
  if (ms <= 0) return "expired";
  return `${Math.max(1, Math.ceil(ms / 60_000))} min`;
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}
