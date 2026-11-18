import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditHistoryEvent, ContainerDTO } from "@/types/api";
import HistoryPage from "./HistoryPage";
import { lineDiff } from "@/lib/diff";
import {
  actorDisplay,
  changeActor,
  changeKind,
  containerNameIndex,
  describeChange,
  groupRepeats,
  resolveTarget,
  uniqueEventKeys,
  whereInfo,
} from "@/lib/history";

let panelMode = false;
vi.mock("@/lib/panelMode", () => ({
  get isPanelMode() {
    return panelMode;
  },
}));

vi.mock("@/lib/api", () => ({
  fetchAuditHistory: vi.fn(),
  fetchContainers: vi.fn(),
}));

vi.mock("@/lib/fleetApi", () => ({
  fetchPolicyVersions: vi.fn(),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderPage(path = "/history") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <HistoryPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function container(id: string, name: string): ContainerDTO {
  return {
    id,
    name,
    status: "running",
    enabled: true,
    firewallStatus: "active",
    labels: {},
  };
}

const agentEvents: AuditHistoryEvent[] = [
  {
    ts: "2026-04-23T10:00:00Z",
    action: "apply",
    source: "api",
    container_id: "abcdef012345",
    container_name: "nginx",
    rule_sets: 2,
    default_policy: "DROP",
  },
  {
    ts: "2026-04-23T10:01:00Z",
    action: "remove",
    source: "event",
    container_id: "fedcba543210",
    container_name: "redis",
  },
  {
    ts: "2026-04-23T10:02:00Z",
    action: "token_rotated",
    source: "api",
  },
];

const panelEvents: AuditHistoryEvent[] = [
  {
    ts: "2026-11-18T10:00:00Z",
    action: "policy_saved",
    source: "panel",
    actor: "admin@198.51.100.7",
    metadata: {
      policy_name: "web-public",
      version: "bbbb",
      sha: "bbbb1",
      previous_version: "aaaa",
      previous_sha: "aaaa1",
      comment: "block KP",
    },
  },
  {
    ts: "2026-11-18T09:00:00Z",
    action: "agent_deleted",
    source: "panel",
    actor: "admin@198.51.100.7",
    agent_id: "old-jump-01",
  },
  {
    ts: "2026-11-18T08:00:00Z",
    action: "apply",
    source: "event",
    agent_id: "app-01",
    agent_hostname: "docker-desktop",
    container_name: "web",
    metadata: { rule_sets: "3", default_policy: "DROP" },
  },
  {
    ts: "2026-11-18T07:00:00Z",
    action: "container_firewall_disabled",
    source: "control-plane",
    actor: "fp:2ae20acbf2b447d1@172.18.0.1",
    agent_id: "app-01",
    container_id: "51023ccbf5bd0000",
  },
  {
    ts: "2026-11-18T06:00:00Z",
    action: "remove",
    source: "event",
    agent_id: "app-01",
    container_id: "724846c5d057ffff",
  },
];

beforeEach(async () => {
  const api = await import("@/lib/api");
  vi.mocked(api.fetchAuditHistory).mockResolvedValue(agentEvents);
  vi.mocked(api.fetchContainers).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  panelMode = false;
});

describe("history helpers", () => {
  it("describes changes for humans", () => {
    expect(describeChange(agentEvents[0]!)).toBe("Rules applied (2 rule sets, default DROP)");
    expect(describeChange({ ts: "", action: "apply", source: "api", rule_sets: 1 })).toBe(
      "Rules applied (1 rule set)",
    );
    expect(describeChange(panelEvents[0]!)).toBe("Policy saved aaaa → bbbb");
    expect(describeChange(panelEvents[2]!)).toBe("Rules applied (3 rule sets, default DROP)");
    expect(describeChange({ ts: "", action: "something_new", source: "x" })).toBe("Something new");
    expect(changeKind("agent_token_revoked")).toBe("tokens");
    expect(changeActor(panelEvents[2]!)).toBe("agent");
    expect(changeActor(panelEvents[0]!)).toBe("admin@198.51.100.7");
  });

  it("shows actors in plain words", () => {
    expect(actorDisplay(panelEvents[0]!)).toEqual({
      label: "admin (198.51.100.7)",
      title: "admin@198.51.100.7",
    });
    expect(actorDisplay(panelEvents[3]!).label).toBe("Operator token (172.18.0.1)");
    expect(actorDisplay(panelEvents[2]!).label).toBe("Agent (automatic)");
  });

  it("resolves container targets by id", () => {
    const names = containerNameIndex([container("51023ccbf5bd0000aaaa", "/fflocal-demo-db")]);
    expect(resolveTarget(panelEvents[3]!, names)).toEqual({
      label: "fflocal-demo-db",
      secondary: "51023ccbf5bd",
    });
    expect(resolveTarget(panelEvents[4]!, names)).toEqual({
      label: "container 724846c5d057 (removed)",
      secondary: "",
    });
    expect(resolveTarget(panelEvents[4]!, undefined)).toEqual({
      label: "724846c5d057",
      secondary: "",
    });
    expect(resolveTarget(agentEvents[0]!, names)).toEqual({
      label: "nginx",
      secondary: "abcdef012345",
    });
    expect(resolveTarget(panelEvents[0]!, names).label).toBe("web-public");
  });

  it("explains where a change came from", () => {
    expect(whereInfo(agentEvents[1]!).label).toBe("docker labels");
    expect(whereInfo({ ts: "", action: "apply", source: "startup" }).description).toMatch(
      /when it started/,
    );
  });

  it("keys events by content, not position", () => {
    const keys = uniqueEventKeys(agentEvents);
    expect(uniqueEventKeys(agentEvents.slice(1))).toEqual(keys.slice(1));
    const dup = uniqueEventKeys([agentEvents[2]!, agentEvents[2]!]);
    expect(new Set(dup).size).toBe(2);
  });

  it("groups identical changes recorded within a minute", () => {
    const base: AuditHistoryEvent = {
      ts: "2026-11-18T10:00:30Z",
      action: "remove",
      source: "event",
      agent_id: "app-01",
      container_id: "e18eedb99ee1",
    };
    const groups = groupRepeats([
      base,
      { ...base, ts: "2026-11-18T10:00:10Z" },
      { ...base, ts: "2026-11-18T10:00:00Z" },
      { ...base, ts: "2026-11-18T09:58:00Z" },
      { ...base, ts: "2026-11-18T09:57:59Z", agent_id: "app-02" },
      { ...base, ts: "2026-11-18T09:57:58Z", source: "api" },
    ]);
    expect(groups.map((g) => g.events.length)).toEqual([3, 1, 1, 1]);
    expect(groups[0]!.head.ts).toBe("2026-11-18T10:00:30Z");
    expect(groupRepeats([agentEvents[0]!, agentEvents[1]!, agentEvents[0]!])).toHaveLength(3);
  });

  it("computes a line diff", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
    expect(lineDiff("", "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });
});

describe("HistoryPage (agent)", () => {
  it("renders all rows with readable descriptions", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    expect(screen.getByText("redis")).toBeInTheDocument();
    expect(screen.getByText("API token rotated")).toBeInTheDocument();
    expect(screen.getByText("docker labels", { selector: "td" })).toHaveAttribute(
      "title",
      expect.stringMatching(/container's firefik labels/),
    );
    expect(screen.getByText(/Showing 3 of 3 events/i)).toBeInTheDocument();
    expect(screen.getByText("What does “Where” mean?")).toBeInTheDocument();
  });

  it("filters by kind and keeps it in the URL", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Kind of change"), "tokens");
    expect(screen.queryByText("nginx")).not.toBeInTheDocument();
    expect(screen.getByText("API token rotated")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("kind=tokens");
  });

  it("filters by search text", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Search"), "redis");
    expect(screen.queryByText("nginx")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 3 events/i)).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("search=redis");
    await user.clear(screen.getByLabelText("Search"));
    await user.type(screen.getByLabelText("Search"), "nope-no-match");
    expect(screen.getByText(/No changes match/i)).toBeInTheDocument();
  });

  it("reads filters from the URL", async () => {
    renderPage("/history?search=redis&kind=containers");
    await waitFor(() => expect(screen.getByText("redis")).toBeInTheDocument());
    expect(screen.queryByText("nginx")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toHaveValue("redis");
    expect(screen.getByLabelText("Kind of change")).toHaveValue("containers");
  });

  it("expands a row to show its details", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    await user.click(screen.getByText("nginx"));
    expect(screen.getByText("abcdef012345", { selector: "dd" })).toBeInTheDocument();
  });

  it("expands a row from the keyboard", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    const toggle = screen.getByRole("button", { name: /Show details: Rules applied/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    await user.keyboard("{Enter}");
    const open = screen.getByRole("button", { name: /Hide details: Rules applied/ });
    expect(open).toHaveAttribute("aria-expanded", "true");
    const controls = open.getAttribute("aria-controls");
    expect(controls && document.getElementById(controls)).toBeTruthy();
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: /Show details: Rules applied/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("collapses repeated changes into one row with a count", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const repeat: AuditHistoryEvent = {
      ts: "2026-04-23T10:05:20Z",
      action: "remove",
      source: "event",
      container_id: "e18eedb99ee1",
    };
    vi.mocked(api.fetchAuditHistory).mockResolvedValue([
      repeat,
      { ...repeat, ts: "2026-04-23T10:05:10Z" },
      { ...repeat, ts: "2026-04-23T10:05:00Z" },
      ...agentEvents,
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("×3")).toBeInTheDocument());
    expect(screen.getAllByText("Rules removed")).toHaveLength(2);
    expect(screen.getByText(/Showing 6 of 6 events/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Show details: Rules removed, 3 times/ }));
    const times = screen.getByRole("list", { name: "All times recorded" });
    expect(times.querySelectorAll("li")).toHaveLength(3);
  });

  it("refreshes and toggles auto-refresh", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    const before = vi.mocked(api.fetchAuditHistory).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(vi.mocked(api.fetchAuditHistory).mock.calls.length).toBeGreaterThan(before),
    );
    const checkbox = screen.getByLabelText("Auto-refresh");
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("renders the error message when fetchAuditHistory rejects", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchAuditHistory).mockRejectedValue(new Error("offline"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the change history: offline",
    );
  });
});

describe("HistoryPage (panel)", () => {
  beforeEach(async () => {
    panelMode = true;
    const api = await import("@/lib/api");
    vi.mocked(api.fetchAuditHistory).mockResolvedValue(panelEvents);
    vi.mocked(api.fetchContainers).mockResolvedValue([
      container("51023ccbf5bd0000aaaa", "fflocal-demo-db"),
    ]);
    const fleet = await import("@/lib/fleetApi");
    vi.mocked(fleet.fetchPolicyVersions).mockResolvedValue([
      {
        version: "bbbb",
        sha: "bbbb1",
        dsl: 'policy "web-public" {\n  block if geo in ["RU", "KP"]\n}',
        author: "admin",
        comment: "block KP",
        committedAt: "2026-11-18T10:00:00Z",
      },
      {
        version: "aaaa",
        sha: "aaaa1",
        dsl: 'policy "web-public" {\n  block if geo in ["RU"]\n}',
        author: "admin",
        comment: "",
        committedAt: "2026-11-17T10:00:00Z",
      },
    ]);
  });

  it("shows who did what and filters by agent and actor", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("Agent removed")).toBeInTheDocument());
    const admins = screen.getAllByText("admin (198.51.100.7)", { selector: "td" });
    expect(admins[0]).toHaveAttribute("title", "admin@198.51.100.7");
    expect(screen.getByText("Operator token (172.18.0.1)", { selector: "td" })).toHaveAttribute(
      "title",
      "fp:2ae20acbf2b447d1@172.18.0.1",
    );
    await user.selectOptions(screen.getByLabelText("Agent"), "app-01");
    expect(screen.getByTestId("location")).toHaveTextContent("agent=app-01");
    expect(screen.queryByText("Agent removed")).not.toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Agent"), "");
    await user.selectOptions(screen.getByLabelText("Who"), "agent");
    expect(screen.getByTestId("location")).toHaveTextContent("actor=agent");
    expect(screen.queryByText(/Policy saved/)).not.toBeInTheDocument();
  });

  it("shows the agent id with the hostname as a tooltip", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("web")).toBeInTheDocument());
    const cells = screen.getAllByText("app-01", { selector: "td" });
    expect(cells.some((c) => c.getAttribute("title") === "docker-desktop")).toBe(true);
    expect(screen.queryByText("docker-desktop", { selector: "td" })).not.toBeInTheDocument();
  });

  it("names containers that only have an id", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("fflocal-demo-db")).toBeInTheDocument());
    expect(screen.getByText("51023ccbf5bd")).toBeInTheDocument();
    expect(screen.getByText("container 724846c5d057 (removed)")).toBeInTheDocument();
  });

  it("starts with the agent and search filters from an agent page link", async () => {
    renderPage("/history?agent=app-01&search=fflocal");
    await waitFor(() => expect(screen.getByText("fflocal-demo-db")).toBeInTheDocument());
    expect(screen.queryByText("web")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Agent")).toHaveValue("app-01");
  });

  it("shows a policy diff when a policy change is expanded", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("Policy saved aaaa → bbbb")).toBeInTheDocument());
    await user.click(screen.getByText("Policy saved aaaa → bbbb"));
    const diff = await screen.findByLabelText("Policy diff");
    expect(diff).toHaveTextContent('- block if geo in ["RU"]');
    expect(diff).toHaveTextContent('+ block if geo in ["RU", "KP"]');
    expect(screen.getAllByText(/block KP/).length).toBeGreaterThan(0);
  });
});
