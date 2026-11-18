import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContainerDTO } from "@/types/api";
import ContainersPage from "./ContainersPage";

vi.mock("@/lib/api", () => ({
  fetchContainers: vi.fn(),
  applyContainerRules: vi.fn(),
  deactivateContainerRules: vi.fn(),
  bulkContainerActions: vi.fn(),
  APIError: class APIError extends Error {
    readonly status: number;
    readonly code: string;
    readonly userMessage: string;
    constructor(status: number, code: string, userMessage: string) {
      super(userMessage);
      this.status = status;
      this.code = code;
      this.userMessage = userMessage;
    }
  },
}));

vi.mock("@/lib/containerYaml", async () => {
  const actual = await vi.importActual<typeof import("@/lib/containerYaml")>("@/lib/containerYaml");
  return {
    ...actual,
    downloadTextFile: vi.fn(),
  };
});

let panelMode = false;
vi.mock("@/lib/panelMode", () => ({
  get isPanelMode() {
    return panelMode;
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

function renderPage(initialPath = "/containers") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <ContainersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

const activeCtr: ContainerDTO = {
  id: "abcdef012345",
  name: "nginx",
  status: "running",
  enabled: true,
  firewallStatus: "active",
  defaultPolicy: "DROP",
  ruleSets: [],
  labels: {},
};

const inactiveCtr: ContainerDTO = {
  id: "ffffaaaa1111",
  name: "redis",
  status: "running",
  enabled: true,
  firewallStatus: "inactive",
  defaultPolicy: "RETURN",
  ruleSets: [],
  labels: { app: "cache" },
};

const disabledCtr: ContainerDTO = {
  id: "1111aaaa2222",
  name: "alpine",
  status: "stopped",
  enabled: false,
  firewallStatus: "disabled",
  ruleSets: [],
  labels: {},
};

beforeEach(async () => {
  const api = await import("@/lib/api");
  vi.mocked(api.fetchContainers).mockResolvedValue([activeCtr, inactiveCtr, disabledCtr]);
  vi.mocked(api.applyContainerRules).mockResolvedValue(undefined);
  vi.mocked(api.deactivateContainerRules).mockResolvedValue(undefined);
  vi.mocked(api.bulkContainerActions).mockResolvedValue({
    results: [],
    summary: { total: 0, applied: 0, disabled: 0, failed: 0 },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  panelMode = false;
});

describe("ContainersPage fleet filters", () => {
  beforeEach(async () => {
    panelMode = true;
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([
      { ...activeCtr, agent_id: "host-a", agent_hostname: "host-a" },
      { ...inactiveCtr, agent_id: "host-b", agent_hostname: "host-b" },
      { ...disabledCtr, agent_id: "host-b", agent_hostname: "host-b" },
    ]);
  });

  it("groups by agent and filters by the agent select", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    expect(screen.getByText("1 container")).toBeInTheDocument();
    expect(screen.getByText("2 containers")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by agent"), "host-b");
    expect(screen.queryByText("nginx")).not.toBeInTheDocument();
    expect(screen.getByText("redis")).toBeInTheDocument();
    expect(screen.queryByText("2 containers")).not.toBeInTheDocument();
  });

  it("narrows to one agent from its group header", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    const buttons = screen.getAllByRole("button", { name: "show only this agent" });
    await user.click(buttons[0]!);
    expect(screen.getByText("nginx")).toBeInTheDocument();
    expect(screen.queryByText("redis")).not.toBeInTheDocument();
  });
});

describe("ContainersPage turn off confirm flow", () => {
  it("shows a confirmation dialog before running the mutation", async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Turn off firewall for nginx"));

    expect(await screen.findByText("Turn off the firewall for nginx?")).toBeInTheDocument();
    const api = await import("@/lib/api");
    expect(api.deactivateContainerRules).not.toHaveBeenCalled();
  });

  it("cancels without calling the backend", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Turn off firewall for nginx"));
    await screen.findByText("Turn off the firewall for nginx?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const api = await import("@/lib/api");
    expect(api.deactivateContainerRules).not.toHaveBeenCalled();
  });

  it("confirms and invokes the backend mutation exactly once", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Turn off firewall for nginx"));
    await screen.findByText("Turn off the firewall for nginx?");

    const confirmButton = screen.getAllByRole("button", { name: "Turn off" }).at(-1);
    if (!confirmButton) throw new Error("confirm button missing");
    await user.click(confirmButton);

    const api = await import("@/lib/api");
    await waitFor(() => expect(api.deactivateContainerRules).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.deactivateContainerRules).mock.calls[0]?.[0]).toBe("abcdef012345");
  });
});

describe("ContainersPage bulk selection", () => {
  it("selects all visible non-disabled rows when the header checkbox is toggled", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const headerCheckbox = screen.getByLabelText(/Select all visible/i);
    await user.click(headerCheckbox);

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByLabelText(/Deselect all/i)).toBeChecked();
  });

  it("performs bulk apply when the Apply selected button is pressed", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Select nginx"));
    await user.click(screen.getByLabelText(/Apply selected/i));

    await waitFor(() => expect(api.bulkContainerActions).toHaveBeenCalled());
    expect(vi.mocked(api.bulkContainerActions).mock.calls[0]?.[0]).toEqual([
      { id: "abcdef012345", action: "apply" },
    ]);
  });

  it("opens a confirm dialog before bulk-disable and runs the mutation when confirmed", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Select nginx"));
    await user.click(screen.getByLabelText("Select redis"));
    await user.click(screen.getByLabelText(/Turn off selected/i));

    expect(await screen.findByText(/Turn off the firewall for 2 containers/i)).toBeInTheDocument();
    expect(api.bulkContainerActions).not.toHaveBeenCalled();

    const dialogButton = screen.getAllByRole("button", { name: /Turn off selected/i }).at(-1);
    if (!dialogButton) throw new Error("confirm bulk disable button missing");
    await user.click(dialogButton);

    await waitFor(() => expect(api.bulkContainerActions).toHaveBeenCalled());
    expect(vi.mocked(api.bulkContainerActions).mock.calls[0]?.[0]).toEqual([
      { id: "abcdef012345", action: "disable" },
      { id: "ffffaaaa1111", action: "disable" },
    ]);
  });

  it("clears selection when the Clear button is pressed", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Select nginx"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Clear selection"));
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });

  it("deselects all visible rows when the header checkbox is toggled while everything is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const headerCheckbox = screen.getByLabelText(/Select all visible/i);
    await user.click(headerCheckbox);
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Deselect all/i));
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
  });
});

describe("ContainersPage search filter", () => {
  it("filters by container name (case-insensitive)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const search = screen.getByLabelText("Filter containers");
    await user.type(search, "REDIS");

    await waitFor(() => expect(screen.queryByText("nginx")).not.toBeInTheDocument());
    expect(screen.getByText("redis")).toBeInTheDocument();
  });

  it("filters by label key/value", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const search = screen.getByLabelText("Filter containers");
    await user.type(search, "cache");
    await waitFor(() => expect(screen.queryByText("nginx")).not.toBeInTheDocument());
    expect(screen.getByText("redis")).toBeInTheDocument();
  });

  it("renders a no-match empty state when filter excludes everything", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    const search = screen.getByLabelText("Filter containers");
    await user.type(search, "zzz-no-match");
    await waitFor(() =>
      expect(screen.getByText(/No containers match the current filters/i)).toBeInTheDocument(),
    );
  });

  it("filters by firewall status chip and keeps it in the URL", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^active/i }));
    expect(screen.getByText("nginx")).toBeInTheDocument();
    expect(screen.queryByText("redis")).not.toBeInTheDocument();
    expect(screen.queryByText("alpine")).not.toBeInTheDocument();
  });

  it("reads filters from the URL", async () => {
    renderPage("/containers?firewall=disabled");
    await waitFor(() => expect(screen.getByText("alpine")).toBeInTheDocument());
    expect(screen.queryByText("nginx")).not.toBeInTheDocument();
  });

  it("hides stopped containers with running only", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("alpine")).toBeInTheDocument());
    await user.click(screen.getByLabelText("running only"));
    expect(screen.queryByText("alpine")).not.toBeInTheDocument();
    expect(screen.getByText("nginx")).toBeInTheDocument();
  });

  it("clears filter via the clear button", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    const search = screen.getByLabelText("Filter containers");
    await user.type(search, "redis");
    await waitFor(() => expect(screen.queryByText("nginx")).not.toBeInTheDocument());
    await user.click(screen.getByLabelText("Clear filter"));
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
  });
});

describe("ContainersPage row actions", () => {
  it("invokes apply when the Re-apply button is clicked", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText(/Re-apply rules for nginx/i));
    await waitFor(() => expect(api.applyContainerRules).toHaveBeenCalled());
    expect(vi.mocked(api.applyContainerRules).mock.calls[0]?.[0]).toBe("abcdef012345");
  });

  it("invokes downloadTextFile with a container-named YAML when Export is clicked", async () => {
    const user = userEvent.setup();
    const yamlMod = await import("@/lib/containerYaml");
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    await user.keyboard("{Enter}");
    const exportBtn = await screen.findByRole("button", { name: /Export config as YAML/i });
    await user.click(exportBtn);
    await waitFor(() => expect(yamlMod.downloadTextFile).toHaveBeenCalled());
    const call = vi.mocked(yamlMod.downloadTextFile).mock.calls[0];
    expect(call?.[1]).toBe("firefik-nginx.yml");
  });

  it("falls back to the id prefix when the container has no name on YAML export", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const yamlMod = await import("@/lib/containerYaml");
    vi.mocked(api.fetchContainers).mockResolvedValue([{ ...activeCtr, name: "" }]);
    renderPage();
    await waitFor(() => expect(screen.getByText(activeCtr.id.slice(0, 12))).toBeInTheDocument());

    const row = screen.getByLabelText(/Open details for/i);
    row.focus();
    await user.keyboard("{Enter}");
    const exportBtn = await screen.findByRole("button", { name: /Export config as YAML/i });
    await user.click(exportBtn);
    await waitFor(() => expect(yamlMod.downloadTextFile).toHaveBeenCalled());
    const call = vi.mocked(yamlMod.downloadTextFile).mock.calls[0];
    expect(call?.[1]).toBe(`firefik-${activeCtr.id.slice(0, 12)}.yml`);
  });

  it("opens the container detail dialog when a row is clicked and renders rule-set badges", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([
      {
        ...activeCtr,
        ruleSets: [
          {
            name: "web",
            ports: [80, 443],
            allowlist: ["10.0.0.0/24"],
            blocklist: ["8.8.8.8"],
            protocol: "tcp",
            profile: "edge",
            log: true,
            rateLimit: { rate: 200, burst: 10 },
            geoBlock: undefined,
            geoAllow: undefined,
          },
        ],
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("button", { name: /Export config as YAML/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("edge")).toBeInTheDocument();
    expect(screen.getByText(/200\/s burst 10/)).toBeInTheDocument();
    expect(screen.getByText(/10\.0\.0\.0\/24/)).toBeInTheDocument();
    expect(screen.getByText(/8\.8\.8\.8/)).toBeInTheDocument();
  });
});

describe("ContainersPage failure modes", () => {
  it("renders the TableError when fetchContainers rejects", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockRejectedValue(new Error("backend down"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Could not connect to backend/i)).toBeInTheDocument(),
    );
  });

  it("disables the master checkbox when nothing is selectable", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([disabledCtr]);
    renderPage();
    await waitFor(() => expect(screen.getByText("alpine")).toBeInTheDocument());
    const headerCheckbox = screen.getByLabelText(/Select all visible/i);
    expect(headerCheckbox).toBeDisabled();
  });

  it("renders the empty state when no containers exist", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No containers yet/i)).toBeInTheDocument());
  });

  it("toggles a container off when its row checkbox is clicked twice", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const checkbox = screen.getByLabelText("Select nginx");
    await user.click(checkbox);
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(checkbox);
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });
});

describe("ContainersPage detail rendering", () => {
  it("renders RETURN as default policy and zero rule-sets when those fields are absent", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([
      { ...activeCtr, defaultPolicy: undefined, ruleSets: undefined },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("button", { name: /Export config as YAML/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("RETURN").length).toBeGreaterThan(0);
  });

  it("renders rule-set details with no allow/block list and ports fallback", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([
      {
        ...activeCtr,
        ruleSets: [
          {
            name: "minimal",
            ports: [],
            allowlist: [],
            blocklist: [],
            geoBlock: undefined,
            geoAllow: undefined,
          },
        ],
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("minimal")).toBeInTheDocument();
    expect(screen.getByText(/Ports:/)).toBeInTheDocument();
    expect(screen.queryByText(/Allowlist:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Blocklist:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Rate limit:/)).not.toBeInTheDocument();
  });

  it("renders the inactive and disabled firewall status badges", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Pending")).toBeInTheDocument();
    expect(table.getByText("Off")).toBeInTheDocument();
  });

  it("renders the stopped status badge with the secondary variant", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("alpine")).toBeInTheDocument());
    expect(screen.getByText("stopped")).toBeInTheDocument();
  });

  it("dismisses the deactivate dialog via onOpenChange when overlay closes", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Turn off firewall for nginx"));
    await screen.findByText("Turn off the firewall for nginx?");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("Turn off the firewall for nginx?")).not.toBeInTheDocument(),
    );
  });
});

describe("ContainersPage keyboard shortcuts", () => {
  it("focuses the search input when '/' is pressed outside an input", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    document.body.focus();
    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByLabelText("Filter containers"));
  });

  it("ignores '/' when typing in an INPUT (handler skips so the slash is preserved)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const search = screen.getByLabelText("Filter containers") as HTMLInputElement;
    search.focus();
    await user.keyboard("/");
    expect(search.value).toBe("/");
  });

  it("invokes apply via the 'a' shortcut on a focused active row", async () => {
    const api = await import("@/lib/api");
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const user = userEvent.setup();
    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    expect(document.activeElement?.tagName).toBe("TR");
    await user.keyboard("a");

    await waitFor(() => expect(api.applyContainerRules).toHaveBeenCalled());
    expect(vi.mocked(api.applyContainerRules).mock.calls[0]?.[0]).toBe("abcdef012345");
  });

  it("opens the turn off confirm dialog via the 'd' shortcut on an active row", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const user = userEvent.setup();
    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    await user.keyboard("d");

    expect(await screen.findByText("Turn off the firewall for nginx?")).toBeInTheDocument();
  });

  it("opens the detail dialog when Space is pressed on a focused row", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    await user.keyboard(" ");
    expect(
      await screen.findByRole("button", { name: /Export config as YAML/i }),
    ).toBeInTheDocument();
  });

  it("ignores keyboard shortcuts when applyingId/deactivatingId is set or no row focused", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    document.body.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    const api = await import("@/lib/api");
    expect(api.applyContainerRules).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    });
    expect(api.applyContainerRules).not.toHaveBeenCalled();
  });

  it("ignores 'd' on inactive rows (only active rows can be turned off)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("redis")).toBeInTheDocument());

    const user = userEvent.setup();
    const row = screen.getByLabelText(/Open details for redis/i);
    row.focus();
    await user.keyboard("d");

    expect(screen.queryByText(/Turn off the firewall/)).not.toBeInTheDocument();
  });
});

describe("ContainersPage off rows and pending markers", () => {
  const offLabelled: ContainerDTO = {
    ...disabledCtr,
    id: "2222bbbb3333",
    name: "demo-db",
    status: "running",
    labels: { "firefik.enable": "true", "firefik.defaultpolicy": "DROP" },
  };

  it("offers Apply and a checkbox for Off rows that carry firefik labels", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([offLabelled, disabledCtr]);
    renderPage();
    await waitFor(() => expect(screen.getByText("demo-db")).toBeInTheDocument());

    expect(screen.getByLabelText("Select demo-db")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select alpine")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Apply rules for alpine: Add firefik labels/)).toBeDisabled();

    await user.click(screen.getByLabelText("Apply rules for demo-db"));
    await waitFor(() => expect(api.applyContainerRules).toHaveBeenCalled());
    expect(vi.mocked(api.applyContainerRules).mock.calls[0]?.[0]).toBe("2222bbbb3333");
  });

  it("shows an applying marker and a sent toast until the next refresh shows the new state", async () => {
    panelMode = true;
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const { toast } = await import("sonner");
    const row = { ...offLabelled, agent_id: "local-01", agent_hostname: "docker-desktop" };
    vi.mocked(api.fetchContainers).mockResolvedValue([row]);
    const { qc } = renderPage();
    await waitFor(() => expect(screen.getByText("demo-db")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Apply rules for demo-db"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Sent to local-01: applying rules to demo-db…"),
    );
    expect(screen.getByText("applying…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Apply rules for demo-db")).toBeDisabled());
    expect(api.applyContainerRules).toHaveBeenCalledTimes(1);

    vi.mocked(api.fetchContainers).mockResolvedValue([
      { ...row, firewallStatus: "active", enabled: true },
    ]);
    await act(() => qc.invalidateQueries());
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getByText("Active")).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByText("applying…")).not.toBeInTheDocument());
  });

  it("names agents by instance id with the hostname as a tooltip", async () => {
    panelMode = true;
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([
      { ...activeCtr, agent_id: "local-01", agent_hostname: "docker-desktop" },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: "local-01" });
    expect(link).toHaveAttribute("title", "Host: docker-desktop");
    expect(screen.queryByText("docker-desktop")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "local-01" })).toBeInTheDocument();
  });

  it("explains the unlisted ports policy in plain words", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    expect(screen.getByText("Unlisted ports")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Docker decides")).toBeInTheDocument();
  });

  it("shows firewall state, agent, labels and links in the detail dialog", async () => {
    panelMode = true;
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([
      {
        ...activeCtr,
        agent_id: "local-01",
        agent_hostname: "docker-desktop",
        labels: { "firefik.enable": "true" },
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Open details for nginx/i));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Active");
    expect(dialog).toHaveTextContent("on docker-desktop");
    expect(dialog).toHaveTextContent("firefik.enable=true");
    expect(dialog).not.toHaveTextContent("Other labels");
    expect(screen.getByRole("link", { name: /Traffic for this container/ })).toHaveAttribute(
      "href",
      "/logs?agent=local-01&container=nginx",
    );
    expect(screen.getByRole("link", { name: /Change history/ })).toHaveAttribute(
      "href",
      "/history?agent=local-01&search=nginx",
    );
  });

  it("keeps the keyboard hints behind a Keyboard shortcuts toggle", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
  });
});

describe("ContainersPage exact links and label folding", () => {
  const cp: ContainerDTO = { ...activeCtr, id: "aaaa00000001", name: "fflocal-cp" };
  const cpInit: ContainerDTO = { ...activeCtr, id: "aaaa00000002", name: "fflocal-cp-init" };

  it("shows only the named container when the link asks for an exact match", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([cp, cpInit]);
    renderPage("/containers?name=fflocal-cp&exact=1");
    await waitFor(() => expect(screen.getByText("fflocal-cp")).toBeInTheDocument());
    expect(screen.queryByText("fflocal-cp-init")).not.toBeInTheDocument();
  });

  it("goes back to substring search once the user edits the search box", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([cp, cpInit]);
    renderPage("/containers?name=fflocal-cp&exact=1");
    await waitFor(() => expect(screen.getByText("fflocal-cp")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Filter containers"), "-");
    await user.type(screen.getByLabelText("Filter containers"), "{Backspace}");
    await waitFor(() => expect(screen.getByText("fflocal-cp-init")).toBeInTheDocument());
    expect(screen.getByText("fflocal-cp")).toBeInTheDocument();
  });

  it("keeps substring matching for a typed name", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([cp, cpInit]);
    renderPage("/containers?name=fflocal-cp");
    await waitFor(() => expect(screen.getByText("fflocal-cp-init")).toBeInTheDocument());
    expect(screen.getByText("fflocal-cp")).toBeInTheDocument();
  });

  it("lists firefik labels first, folds the rest and puts rule sets above labels", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.fetchContainers).mockResolvedValue([
      {
        ...activeCtr,
        labels: {
          "com.docker.compose.project": "demo",
          "com.docker.compose.service": "web",
          "firefik.enable": "true",
        },
        ruleSets: [{ name: "web", ports: [80], allowlist: [], blocklist: [], protocol: "tcp" }],
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Open details for nginx/i));
    const dialog = await screen.findByRole("dialog");

    const summary = within(dialog).getByText("Other labels (2)");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("com.docker.compose.project=demo");
    expect(within(dialog).getByText("firefik.enable").closest("details")).toBeNull();

    const ruleSets = within(dialog).getByText("Rule sets");
    const labels = within(dialog).getByText("Labels");
    expect(
      ruleSets.compareDocumentPosition(labels) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
