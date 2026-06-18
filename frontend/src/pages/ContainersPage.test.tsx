import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ContainersPage />
    </QueryClientProvider>,
  );
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
});

describe("ContainersPage deactivate confirm flow", () => {
  it("shows a confirmation dialog before running the mutation", async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Deactivate firewall for nginx"));

    expect(await screen.findByText("Deactivate firewall?")).toBeInTheDocument();
    const api = await import("@/lib/api");
    expect(api.deactivateContainerRules).not.toHaveBeenCalled();
  });

  it("cancels without calling the backend", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Deactivate firewall for nginx"));
    await screen.findByText("Deactivate firewall?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const api = await import("@/lib/api");
    expect(api.deactivateContainerRules).not.toHaveBeenCalled();
  });

  it("confirms and invokes the backend mutation exactly once", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Deactivate firewall for nginx"));
    await screen.findByText("Deactivate firewall?");

    const confirmButton = screen.getAllByRole("button", { name: "Deactivate" }).at(-1);
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
    await user.click(screen.getByLabelText(/Disable selected/i));

    expect(await screen.findByText(/Disable 2 container/i)).toBeInTheDocument();
    expect(api.bulkContainerActions).not.toHaveBeenCalled();

    const dialogButton = screen.getAllByRole("button", { name: /Disable selected/i }).at(-1);
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
      expect(screen.getByText(/No containers match "zzz-no-match"/i)).toBeInTheDocument(),
    );
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
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
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

    await user.click(screen.getByLabelText("Deactivate firewall for nginx"));
    await screen.findByText("Deactivate firewall?");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Deactivate firewall?")).not.toBeInTheDocument());
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

    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    expect(document.activeElement?.tagName).toBe("TR");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });

    await waitFor(() => expect(api.applyContainerRules).toHaveBeenCalled());
    expect(vi.mocked(api.applyContainerRules).mock.calls[0]?.[0]).toBe("abcdef012345");
  });

  it("opens deactivate confirm dialog via the 'd' shortcut on an active row", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("nginx")).toBeInTheDocument());

    const row = screen.getByLabelText(/Open details for nginx/i);
    row.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    });

    expect(await screen.findByText("Deactivate firewall?")).toBeInTheDocument();
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

  it("ignores 'd' on inactive rows (only active rows can be deactivated)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("redis")).toBeInTheDocument());

    const row = screen.getByLabelText(/Open details for redis/i);
    row.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    });

    expect(screen.queryByText("Deactivate firewall?")).not.toBeInTheDocument();
  });
});
