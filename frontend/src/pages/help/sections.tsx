import { Link } from "react-router-dom";
import {
  ArchitectureDiagram,
  Callout,
  Code,
  Figure,
  MockRow,
  MockWindow,
  Pill,
  RuleOrderDiagram,
  Steps,
} from "./illustrations";

function H({ children }: { children: string }) {
  return <h2 className="text-2xl font-semibold tracking-tight text-balance">{children}</h2>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-6 text-muted-foreground max-w-prose">{children}</p>;
}

export function Overview() {
  return (
    <>
      <H>Firefik in one minute</H>
      <P>
        Firefik is a firewall for Docker containers. You describe who may reach a container, and
        Firefik turns that into firewall rules on the host. Every host runs a small{" "}
        <strong>agent</strong>. Agents report to the <strong>control plane</strong>, and this panel
        shows what all of them are doing.
      </P>
      <Figure caption="Agents on each host talk to the control plane; the panel reads from it.">
        <ArchitectureDiagram />
      </Figure>
      <Steps
        items={[
          {
            title: "Add a host",
            text: "Install the agent once per server. It appears in Fleet within a minute.",
          },
          {
            title: "Protect a container",
            text: "Add a few Docker labels that say which ports are open and to whom.",
          },
          {
            title: "Watch and adjust",
            text: "The Traffic log shows who was blocked, Change history shows who changed what.",
          },
        ]}
      />
    </>
  );
}

export function FleetStatuses() {
  return (
    <>
      <H>Reading the Fleet page</H>
      <P>
        Fleet lists every host with an agent. The status tells you how recently the agent checked
        in.
      </P>
      <Figure caption="Fleet with one host offline for days: it is listed first and can be removed.">
        <MockWindow title="Fleet">
          <MockRow
            highlight
            cells={[
              <span className="font-mono">old-host</span>,
              <Pill tone="bad">dead</Pill>,
              "11 d ago",
              <Pill tone="bad">Remove</Pill>,
            ]}
          />
          <MockRow
            cells={[
              <span className="font-mono">web-01</span>,
              <Pill tone="ok">healthy</Pill>,
              "6 s ago",
              <span className="text-muted-foreground">—</span>,
            ]}
          />
        </MockWindow>
      </Figure>
      <ul className="text-sm space-y-2">
        <li>
          <Pill tone="ok">healthy</Pill> — checked in during the last 90 seconds.
        </li>
        <li>
          <Pill tone="warn">stale</Pill> — silent for 90 seconds to 5 minutes. Often a short network
          hiccup.
        </li>
        <li>
          <Pill tone="bad">dead</Pill> — silent for more than 5 minutes. The host is down, the agent
          stopped, or it cannot reach the control plane.
        </li>
      </ul>
      <Callout title="Removing a host you no longer have">
        Press <strong>Remove</strong> next to a stale or dead agent. Tick “Also revoke its agent
        token” so the old host can never reconnect. Healthy agents cannot be removed: they would
        register again on their next check-in.
      </Callout>
    </>
  );
}

export function AddHost() {
  return (
    <>
      <H>Adding a new host</H>
      <Steps
        items={[
          {
            title: "Open Fleet → Add agent",
            text: "Type a short name for the host (lowercase letters, digits and dashes).",
          },
          {
            title: "Check the two addresses",
            text: "They are where the new host reaches the control plane. They are filled in for you when the control plane knows them.",
          },
          {
            title: "Generate token and run step 1 on the host",
            text: "Copy the command and run it as root. It exchanges the one-time token for a certificate.",
          },
          {
            title: "Start the agent with the step 2 snippet",
            text: "The host shows up in Fleet as healthy within about 30 seconds.",
          },
        ]}
      />
      <Figure caption="Add agent: the token works only once and expires after the minutes you chose.">
        <MockWindow title="Add agent">
          <MockRow cells={["Instance ID", <span className="font-mono">web-02</span>]} />
          <MockRow
            cells={["Code expires after (minutes)", <span className="font-mono">30</span>]}
          />
          <MockRow
            cells={["Enrollment address", <span className="font-mono">https://fw.example</span>]}
          />
          <MockRow
            cells={["Agent connection address", <span className="font-mono">fw.example:8444</span>]}
          />
          <div className="pt-1">
            <Pill tone="primary">Generate token</Pill>
          </div>
        </MockWindow>
      </Figure>
    </>
  );
}

export function ProtectContainer() {
  return (
    <>
      <H>Protecting a container</H>
      <P>
        Rules live next to the container, as Docker labels in your compose file. Firefik picks them
        up automatically when the container starts or its labels change.
      </P>
      <Code>{`services:
  api:
    labels:
      firefik.enable: "true"            # turn Firefik on for this container
      firefik.defaultpolicy: "DROP"     # block ports you did not list
      firefik.firewall.web.ports: "443"
      firefik.firewall.web.allowlist: "0.0.0.0/0"      # anyone may use 443
      firefik.firewall.ssh.ports: "22"
      firefik.firewall.ssh.allowlist: "10.0.0.0/8"     # only the office VPN`}</Code>
      <P>Each packet is checked against a rule in this order:</P>
      <Figure caption="Listing a port closes it to everyone who is not on its allowlist.">
        <RuleOrderDiagram />
      </Figure>
      <Callout tone="warn" title="DROP, RETURN or ACCEPT?">
        <strong>DROP</strong> blocks everything you did not list — the safe choice.{" "}
        <strong>RETURN</strong> lets Docker&apos;s own rules decide, so Firefik blocks nothing extra
        on unlisted ports. <strong>ACCEPT</strong> opens unlisted ports to everyone.
      </Callout>
      <P>
        Useful extras per rule: <code>blocklist</code>, <code>protocol: udp</code>,{" "}
        <code>profile: web</code> (ports 80 and 443 for everyone), <code>profile: internal</code>{" "}
        (private networks only), <code>ratelimit.rate</code>, <code>geoblock: CN,RU</code>, and{" "}
        <code>log: true</code>.
      </P>
    </>
  );
}

export function ContainersHelp() {
  return (
    <>
      <H>Finding a container</H>
      <P>
        Containers shows every container on every host. Narrow the list with the filters at the top:
        pick an agent, type part of a name, or show only containers whose firewall is active. The
        filters stay in the address bar, so you can bookmark or share the view.
      </P>
      <Figure caption="Containers filtered to one agent and the word “front”.">
        <MockWindow title="Containers">
          <div className="flex flex-wrap gap-2">
            <Pill tone="primary">Agent: web-01</Pill>
            <Pill>front</Pill>
            <Pill tone="primary">Active 3</Pill>
          </div>
          <MockRow cells={["web-front", <Pill tone="ok">Active</Pill>, "Blocked", "2 rule sets"]} />
          <MockRow
            cells={["admin-front", <Pill tone="ok">Active</Pill>, "Blocked", "1 rule set"]}
          />
        </MockWindow>
      </Figure>
      <ul className="text-sm space-y-1 text-muted-foreground">
        <li>
          <Pill tone="ok">Active</Pill> rules are in place.
        </li>
        <li>
          <Pill tone="warn">Pending</Pill> Firefik is enabled but the rules are not in place yet.
        </li>
        <li>
          <Pill>Off</Pill> no Firefik rules: either the container has no <code>firefik.enable</code>{" "}
          label, or someone turned its firewall off.
        </li>
      </ul>
      <P>
        <strong>Re-apply</strong> rebuilds an active container&apos;s rules.{" "}
        <strong>Turn off</strong> removes them and the container&apos;s traffic stops being filtered
        right away; you are always asked first. <strong>Apply</strong> turns the rules back on for a
        container that has Firefik labels. While the agent works on it, the row shows “applying…”.
      </P>
      <P>
        The <strong>Unlisted ports</strong> column says what happens to ports you did not list:
        Blocked (DROP), Docker decides (RETURN) or Open (ACCEPT).
      </P>
    </>
  );
}

export function RulesHelp() {
  return (
    <>
      <H>Checking applied rules</H>
      <P>
        Rules shows the rules each host is enforcing right now, grouped by host: first the host
        firewall, then every protected container. Use the search boxes to answer questions like “who
        may reach port 5432?” or “where is 10.0.0.5 allowed?”.
      </P>
      <Callout title="Rules come from labels">
        To change a container&apos;s rules, edit its labels and redeploy it. The Rules page updates
        on its own a few seconds later.
      </Callout>
    </>
  );
}

export function TrafficHelp() {
  return (
    <>
      <H>Who is knocking: the Traffic log</H>
      <P>
        Every agent records blocked traffic: packets stopped by a default policy and packets sent to
        a protected port from an address that is not allowed. The Traffic log groups identical
        attempts, so a scanner hammering port 22 is one line with a count.
      </P>
      <Figure caption="Last 24 h: one address tried SSH on the host 4,211 times.">
        <MockWindow title="Traffic log · Last 24 h">
          <MockRow cells={["Dropped", "Unique sources", "Top port"]} />
          <MockRow
            cells={[<strong>18,412</strong>, <strong>1,307</strong>, <strong>22/tcp</strong>]}
          />
          <MockRow
            highlight
            cells={[
              "4,211",
              <span className="font-mono">185.220.101.7</span>,
              "host :22",
              <Pill tone="bad">DROP</Pill>,
            ]}
          />
        </MockWindow>
      </Figure>
      <Steps
        items={[
          {
            title: "Pick a period",
            text: "Live shows packets as they arrive; Last 24 h and 7 days show totals. History is kept for 7 days.",
          },
          {
            title: "Filter",
            text: "By agent, container, source address (or its beginning, like 185.220.), port, or Dropped / Accepted.",
          },
          {
            title: "Read “Matched rule”",
            text: "“default policy” means nothing allowed the packet; a rule name means that rule blocked it.",
          },
        ]}
      />
      <P>
        Click an address, port, container or agent in any row to filter by it. The filters stay in
        the address bar, so you can share the view.
      </P>
      <Callout title="Want to see accepted traffic too?">
        Add <code>firefik.firewall.&lt;rule&gt;.log: &quot;true&quot;</code> to a rule. Logging is
        limited to 10 packets per second per rule, so it never floods the host.
      </Callout>
      <Callout title="For administrators">
        Dropped-packet logging is on by default. Turn it off on an agent with{" "}
        <code>FIREFIK_LOG_DEFAULT_DROP=false</code>, or change the limit with{" "}
        <code>FIREFIK_LOG_DEFAULT_DROP_RATE</code>. The control plane keeps the log for 7 days (
        <code>--flow-retention</code>).
      </Callout>
    </>
  );
}

export function HistoryHelp() {
  return (
    <>
      <H>Who changed what: Change history</H>
      <P>
        Every change made in this panel is recorded with the person and address that made it, and
        every rule change an agent applies is recorded too. Click a row to see the details; for a
        policy you get a line-by-line comparison with the previous version.
      </P>
      <Figure caption="A policy edit, expanded: removed lines in red, added lines in green.">
        <MockWindow title="Change history">
          <MockRow
            cells={["2 min ago", "admin (198.51.100.7)", "Policy saved v3 → v4", "web-public"]}
            highlight
          />
          <pre className="rounded border bg-muted/40 p-2 font-mono text-[11px] leading-5">
            <span className="text-red-600 dark:text-red-400">
              - block if geo in [&quot;RU&quot;]
            </span>
            {"\n"}
            <span className="text-green-600 dark:text-green-400">
              + block if geo in [&quot;RU&quot;, &quot;KP&quot;]
            </span>
          </pre>
          <MockRow
            cells={["1 h ago", "Agent (automatic)", "Rules applied (3 rule sets)", "web-front"]}
          />
        </MockWindow>
      </Figure>
      <P>
        “Who” is the signed-in user and their address. Changes made with the shared operator token
        show as “Operator token”; changes an agent made on its own show as “Agent (automatic)”.
      </P>
      <P>
        “Where” tells you how the change happened: <em>panel</em> (someone clicked here),{" "}
        <em>docker labels</em> (a container was deployed or changed), <em>agent API</em>,{" "}
        <em>startup</em> (the agent re-applied everything when it started), or <em>drift check</em>{" "}
        (the agent noticed firewall rules that differ from what it expects — press Reconcile on the
        agent page to rebuild them). The legend under the table explains every value. History is
        kept for 90 days.
      </P>
    </>
  );
}

export function PoliciesHelp() {
  return (
    <>
      <H>Policies</H>
      <P>
        A policy describes rules in a short language instead of labels. Write or paste it, pick a
        container and press <strong>Simulate</strong> to see the rules it would get, and{" "}
        <strong>Save</strong> to keep a new version with your comment. Change history shows the
        difference between versions.
      </P>
      <Callout tone="warn" title="Saving does not apply a policy">
        Policies saved here stay on the control plane; they are not sent to agents yet. To enforce a
        policy on a host, put the policy file in the agent&apos;s policies folder (
        <code>FIREFIK_POLICIES_DIR</code>, read when the agent starts) and add the label{" "}
        <code>firefik.policy: &quot;&lt;name&gt;&quot;</code> to the container.
      </Callout>
      <Code>{`policy "web-public" {
  allow if proto == "tcp" and port in [80, 443]
  block if geo in ["RU", "CN"]
  log   if port == 22
}`}</Code>
    </>
  );
}

export function TemplatesHelp() {
  return (
    <>
      <H>Templates</H>
      <P>
        A template is a named rule set you can reuse on many containers. A container uses one with a
        single label.
      </P>
      <Callout tone="warn" title="Publishing does not reach agents yet">
        Templates published on the Templates page are stored on the control plane only. Agents read
        templates from their templates file (<code>FIREFIK_TEMPLATES_FILE</code>), so add the
        template there on each host that needs it.
      </Callout>
      <Code>{`labels:
  firefik.enable: "true"
  firefik.template: "web-public"`}</Code>
    </>
  );
}

export function ApprovalsHelp() {
  return (
    <>
      <H>Approvals (four eyes)</H>
      <P>
        On the Policies page, <strong>Send for review</strong> asks another operator to check a
        policy change. The request waits on the Approvals page until someone with a different
        operator identity (for example a different API token) approves or rejects it. Nobody can
        approve their own request, and each decision appears in Change history.
      </P>
      <Callout tone="warn" title="Approving records a decision only">
        Approving does not save or apply the policy. Also, every request made through this panel
        uses the same operator identity, so a request sent from the panel cannot be approved from
        the panel yet.
      </Callout>
    </>
  );
}

export function ProposalsHelp() {
  return (
    <>
      <H>Proposals: let Firefik suggest rules</H>
      <P>
        Not sure which ports a container needs? Start the agent with{" "}
        <code>FIREFIK_AUTOGEN_MODE=observe</code> (and optionally{" "}
        <code>FIREFIK_AUTOGEN_MIN_SAMPLES</code>). It watches real traffic for a while and suggests
        rules on the Proposals page. Approve a proposal to get ready-to-paste labels or a policy
        snippet; nothing is applied until you add it yourself.
      </P>
    </>
  );
}

export function TokensHelp() {
  return (
    <>
      <H>Agent tokens</H>
      <P>
        Most hosts do not need this page:{" "}
        <Link to="/fleet/add" className="underline">
          Fleet → Add agent
        </Link>{" "}
        gives a new host a certificate with a one-time token, and that is enough.
      </P>
      <P>
        A long-lived agent token is for hosts that cannot use one-time enrollment. Issue it here,
        copy it right away (it is shown only once) and put it in a file on the host referenced by{" "}
        <code>FIREFIK_CONTROL_PLANE_TOKEN_FILE</code>. Revoke a token when a host is retired; the
        Agent column shows whether its host is still alive.
      </P>
    </>
  );
}

export function Troubleshooting() {
  return (
    <>
      <H>When something looks wrong</H>
      <div className="space-y-4 text-sm">
        <div>
          <p className="font-medium">A host shows as dead</p>
          <P>
            Check that the agent container is running on that host and can reach the gRPC address
            from Add agent. If the host is gone for good, remove it from Fleet.
          </P>
        </div>
        <div>
          <p className="font-medium">The Traffic log is empty for a container</p>
          <P>
            Its default policy is probably RETURN, so Firefik itself blocks nothing on unlisted
            ports. Set <code>firefik.defaultpolicy: &quot;DROP&quot;</code> or list the ports you
            want to guard. Also check that the container shows as Active on{" "}
            <Link to="/containers" className="underline">
              Containers
            </Link>
            .
          </P>
        </div>
        <div>
          <p className="font-medium">A container is not protected</p>
          <P>
            It needs <code>firefik.enable: &quot;true&quot;</code>. After changing labels, recreate
            the container so Docker picks them up.
          </P>
        </div>
        <div>
          <p className="font-medium">Something legitimate is blocked</p>
          <P>
            Find it in the Traffic log, note the source address and port, then add the address to
            that rule&apos;s allowlist.
          </P>
        </div>
      </div>
    </>
  );
}
