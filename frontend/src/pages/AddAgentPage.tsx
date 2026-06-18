import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { createEnrollmentToken, type EnrollmentToken } from "@/lib/fleetApi";
import { isValidInstanceID, isValidHTTPURL, isValidGRPCEndpoint } from "@/lib/enrollValidators";

const DEFAULT_CP_HTTP = "https://cp.example.com:8443";
const DEFAULT_CP_GRPC = "cp.example.com:8444";
const DEFAULT_TTL_MINUTES = 15;

export default function AddAgentPage() {
  const [instanceID, setInstanceID] = useState("host-01");
  const [cpHTTP, setCpHTTP] = useState(DEFAULT_CP_HTTP);
  const [cpGRPC, setCpGRPC] = useState(DEFAULT_CP_GRPC);
  const [ttlMinutes, setTtlMinutes] = useState(DEFAULT_TTL_MINUTES);
  const [issued, setIssued] = useState<EnrollmentToken | null>(null);

  const validInstance = isValidInstanceID(instanceID);
  const validHTTP = isValidHTTPURL(cpHTTP);
  const validGRPC = isValidGRPCEndpoint(cpGRPC);
  const valid = validInstance && validHTTP && validGRPC;

  const create = useMutation({
    mutationFn: () => createEnrollmentToken(instanceID, ttlMinutes * 60),
    onSuccess: (tok) => {
      setIssued(tok);
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

  const expiresIn = formatExpiresIn(issued);

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link to="/fleet" className="text-sm text-muted-foreground underline">
          ← Fleet
        </Link>
        <h1 className="text-2xl font-bold">Add agent</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Create a one-time enrollment token, then paste the bash snippet on the new host. The agent
        will exchange the token for a short-lived mTLS client cert via the embedded mini-CA, then
        connect to the control plane via gRPC and self-register. Token is single-use and expires in
        the chosen TTL.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Instance ID" hint="DNS-label format, e.g. host-prod-01">
          <input
            value={instanceID}
            onChange={(e) => {
              setInstanceID(e.target.value.trim());
              setIssued(null);
            }}
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm w-full font-mono"
          />
          {!validInstance && (
            <span className="text-xs text-destructive">Must match [a-z0-9-]{`{3,63}`}</span>
          )}
        </Field>

        <Field label="Token TTL (minutes)" hint="Single-use; 1–1440">
          <input
            type="number"
            min={1}
            max={1440}
            value={ttlMinutes}
            onChange={(e) =>
              setTtlMinutes(Math.max(1, parseInt(e.target.value, 10) || DEFAULT_TTL_MINUTES))
            }
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm w-full font-mono"
          />
        </Field>

        <Field label="CP HTTP endpoint" hint="Where the host will exchange the token for a cert">
          <input
            value={cpHTTP}
            onChange={(e) => setCpHTTP(e.target.value.trim())}
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm w-full font-mono"
          />
          {!validHTTP && (
            <span className="text-xs text-destructive">
              Must be https://host[:port][/path] (no shell-special chars)
            </span>
          )}
        </Field>

        <Field label="CP gRPC endpoint" hint="For agent ↔ control-plane streaming">
          <input
            value={cpGRPC}
            onChange={(e) => setCpGRPC(e.target.value.trim())}
            className="border border-input bg-background text-foreground placeholder:text-muted-foreground px-2 py-1 rounded text-sm w-full font-mono"
          />
          {!validGRPC && (
            <span className="text-xs text-destructive">
              Must be host:port (DNS / IP, port 1–65535)
            </span>
          )}
        </Field>
      </div>

      <div className="flex gap-2 items-center">
        <Button disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Generating…" : issued ? "Generate new token" : "Generate token"}
        </Button>
        {issued && (
          <span className="text-sm text-muted-foreground">
            token:{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              {issued.token.slice(0, 12)}…
            </code>{" "}
            • expires in {expiresIn}
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
                Step 1 consumes the token (single-use) and writes mTLS cert + key + CA bundle to{" "}
                <code>/etc/firefik/</code>.
              </li>
              <li>Step 2 starts the agent which dials CP gRPC and self-registers.</li>
              <li>
                The new host appears in{" "}
                <Link to="/fleet" className="underline">
                  /fleet
                </Link>{" "}
                within ~30s. Status:{" "}
                <Badge variant="default" className="text-xs">
                  healthy
                </Badge>{" "}
                <Badge variant="secondary" className="text-xs">
                  stale
                </Badge>{" "}
                <Badge variant="destructive" className="text-xs">
                  dead
                </Badge>
                .
              </li>
              <li>Token expires automatically; re-issue here if needed.</li>
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

function formatExpiresIn(issued: EnrollmentToken | null): string {
  if (!issued) return "";
  const ms = new Date(issued.expires_at).getTime() - Date.now();
  if (ms <= 0) return "expired";
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
