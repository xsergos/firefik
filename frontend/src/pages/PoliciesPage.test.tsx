import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ContainerDTO,
  PolicyDetail,
  PolicySimulateResponse,
  PolicySummary,
  PolicyValidateResponse,
} from "@/types/api";
import PoliciesPage from "./PoliciesPage";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("./PolicyEditor", () => ({
  default: ({
    value,
    onChange,
    className,
  }: {
    value: string;
    onChange: (v: string) => void;
    className?: string;
  }) => (
    <textarea
      data-testid="policy-editor"
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("@/lib/controlPlaneApi", () => ({
  createApproval: vi.fn(),
}));

vi.mock("@/lib/fleetApi", () => ({
  whoami: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchContainers: vi.fn(),
  fetchPolicies: vi.fn(),
  fetchPolicy: vi.fn(),
  validatePolicy: vi.fn(),
  simulatePolicy: vi.fn(),
  savePolicy: vi.fn(),
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

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <PoliciesPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function clearEditorTo(user: ReturnType<typeof userEvent.setup>, text: string) {
  const editor = (await screen.findByTestId("policy-editor")) as HTMLTextAreaElement;
  await user.clear(editor);
  await user.type(editor, text);
}

const containers: ContainerDTO[] = [
  {
    id: "abcdef0123456789",
    name: "web",
    status: "running",
    enabled: true,
    firewallStatus: "active",
    labels: {},
    agent_id: "a1",
    agent_hostname: "host-one",
  },
  {
    id: "1234567890abcdef",
    name: "db",
    status: "running",
    enabled: true,
    firewallStatus: "active",
    labels: {},
    agent_id: "a2",
    agent_hostname: "host-two",
  },
];

const summaries: PolicySummary[] = [
  { name: "web-public", version: "v1abc234567def", source: "/etc/policies/web.dsl", rules: 3 },
];

const detail: PolicyDetail = {
  name: "web-public",
  version: "v1abc234567def",
  source: "/etc/policies/web.dsl",
  dsl: "policy 'web-public' { allow if proto == 'tcp' }",
  ruleSets: [],
};

const okValidation: PolicyValidateResponse = { ok: true };
const badValidation: PolicyValidateResponse = {
  ok: false,
  errors: ["unexpected token"],
  warnings: ["deprecated keyword"],
};

const simulation: PolicySimulateResponse = {
  policy: "web-public",
  container: "abcdef012345",
  defaultPolicy: "DROP",
  ruleSets: [
    {
      name: "rs0",
      ports: [80, 443],
      allowlist: ["10.0.0.0/24"],
      blocklist: [],
      protocol: "tcp",
      log: true,
    },
  ],
  warnings: ["heads up"],
};

beforeEach(async () => {
  const api = await import("@/lib/api");
  vi.mocked(api.fetchPolicies).mockResolvedValue(summaries);
  vi.mocked(api.fetchPolicy).mockResolvedValue(detail);
  vi.mocked(api.validatePolicy).mockResolvedValue(okValidation);
  vi.mocked(api.simulatePolicy).mockResolvedValue(simulation);
  vi.mocked(api.savePolicy).mockResolvedValue(summaries[0]!);
  vi.mocked(api.fetchContainers).mockResolvedValue(containers);
  const fleet = await import("@/lib/fleetApi");
  vi.mocked(fleet.whoami).mockResolvedValue({ username: "alice", auth_kind: "session" });
  const cp = await import("@/lib/controlPlaneApi");
  vi.mocked(cp.createApproval).mockResolvedValue({
    id: "ap1",
    policy_name: "web-public",
    proposed_body: "x",
    requester: "alice",
    requester_fingerprint: "fp",
    requested_at: "2026-01-01T00:00:00Z",
    approver: "",
    approver_fingerprint: "",
    status: "pending",
    rejection_comment: "",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PoliciesPage", () => {
  it("renders the heading and the saved-policies sidebar", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Policies" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("web-public")).toBeInTheDocument());
    expect(screen.getByText(/3 rules/)).toBeInTheDocument();
    await screen.findByTestId("policy-editor");
  });

  it("loads the policy DSL into the editor when a sidebar entry is selected", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("policy-editor");
    await waitFor(() => expect(screen.getByText("web-public")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /web-public/i }));
    await waitFor(() => {
      const editor = screen.getByTestId("policy-editor") as HTMLTextAreaElement;
      expect(editor.value).toContain("allow if proto");
    });
  });

  it("shows the green Syntax OK message after debounced validation succeeds", async () => {
    renderPage();
    await screen.findByTestId("policy-editor");
    await waitFor(() => expect(screen.getByText(/Syntax OK/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  it("shows validation errors and warnings when the response is not ok", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.validatePolicy).mockResolvedValue(badValidation);
    renderPage();
    await screen.findByTestId("policy-editor");
    await waitFor(() => expect(screen.getByText(/unexpected token/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(screen.getByText(/deprecated keyword/i)).toBeInTheDocument();
  });

  it("invokes simulatePolicy and renders the simulation panel", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("policy-editor");

    const nameInput = screen.getByLabelText(/^Name/);
    await user.type(nameInput, "my-policy");
    await user.type(screen.getByLabelText("Search containers"), "host-two");
    const picker = screen.getByLabelText(/Container to test against/i);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "db · a2" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("option", { name: "db · a2" })).toHaveAttribute(
      "title",
      expect.stringContaining("Host: host-two"),
    );
    expect(screen.queryByRole("option", { name: "web · a1" })).not.toBeInTheDocument();
    await user.selectOptions(picker, "a2::1234567890abcdef");
    await user.click(screen.getByRole("button", { name: "Simulate" }));

    const api = await import("@/lib/api");
    await waitFor(() => expect(api.simulatePolicy).toHaveBeenCalled());
    expect(vi.mocked(api.simulatePolicy).mock.calls[0]?.[0]).toBe("my-policy");
    expect(vi.mocked(api.simulatePolicy).mock.calls[0]?.[1]).toMatchObject({
      containerID: "1234567890abcdef",
      agentID: "a2",
    });
    await waitFor(() => expect(screen.getByText(/Simulation: web-public/i)).toBeInTheDocument());
    expect(screen.getByText(/heads up/i)).toBeInTheDocument();
    const rule = screen.getByText("allow · tcp · ports 80, 443 · from 10.0.0.0/24 · logged");
    expect(rule.closest("li")).toHaveAttribute("title", "Rule ID: rs0");
    expect(screen.queryByText(/abcdef012345/)).not.toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("names the simulated container and reads compiled rule ids as plain text", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.simulatePolicy).mockResolvedValue({
      policy: "web-public",
      container: "abcdef012345",
      ruleSets: [
        {
          name: "pol:web-public@1c4f8fa8edafd616#block-0",
          ports: [22],
          allowlist: [],
          blocklist: ["0.0.0.0/0", "::/0"],
          protocol: "tcp",
        },
      ],
    });
    renderPage();
    await screen.findByTestId("policy-editor");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "web · a1" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() =>
      expect(screen.getByText("web · a1", { selector: "span" })).toBeInTheDocument(),
    );
    expect(screen.getByText("block · tcp · port 22 · from anywhere")).toHaveAttribute(
      "title",
      "Rule ID: pol:web-public@1c4f8fa8edafd616#block-0",
    );
    expect(screen.queryByText(/pol:web-public@/)).not.toBeInTheDocument();
  });

  it("warns and skips simulate when no name is provided", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    renderPage();
    await clearEditorTo(user, "# no policy header yet");

    await user.click(screen.getByRole("button", { name: "Simulate" }));
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("name required"));
  });

  it("saves the policy after a valid response and shows a success toast", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const { toast } = await import("sonner");
    renderPage();
    await screen.findByTestId("policy-editor");

    const nameInput = screen.getByLabelText(/^Name/);
    await user.type(nameInput, "my-policy");
    await user.type(screen.getByLabelText(/Save comment/i), "first save");
    await waitFor(() => expect(screen.getByText(/Syntax OK/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.savePolicy).toHaveBeenCalled());
    expect(vi.mocked(api.savePolicy).mock.calls[0]?.[2]).toBe("first save");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Saved")),
    );
  });

  it("resets the buffer to the template when New policy is pressed", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("policy-editor");

    await user.click(screen.getByRole("button", { name: /\+ New policy/i }));
    const editor = screen.getByTestId("policy-editor") as HTMLTextAreaElement;
    expect(editor.value).toContain("Paste or author a policy");
  });

  it("renders an empty-list message when no saved policies exist", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.fetchPolicies).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No saved policies/i)).toBeInTheDocument());
  });

  it("toasts an error when loading the selected policy fails", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const { toast } = await import("sonner");
    vi.mocked(api.fetchPolicy).mockRejectedValue(new Error("disk on fire"));
    renderPage();
    await waitFor(() => expect(screen.getByText("web-public")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /web-public/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Load policy failed")),
    );
  });

  it("clears validation when the buffer becomes empty", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Syntax OK/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
    const editor = screen.getByTestId("policy-editor") as HTMLTextAreaElement;
    await user.clear(editor);
    await waitFor(() => expect(screen.queryByText(/Syntax OK/i)).not.toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  it("warns and skips Save when no name is provided", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    const api = await import("@/lib/api");
    vi.mocked(api.validatePolicy).mockResolvedValue({ ok: true });
    renderPage();
    await clearEditorTo(user, "# no policy header yet");
    await waitFor(() => expect(screen.getByText(/Syntax OK/i)).toBeInTheDocument(), {
      timeout: 2000,
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("name required"));
    expect(api.savePolicy).not.toHaveBeenCalled();
  });

  it("surfaces APIError messages from simulate via toast.error", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const { toast } = await import("sonner");
    const ApiErrorClass = api.APIError as unknown as new (
      status: number,
      code: string,
      userMessage: string,
    ) => Error;
    vi.mocked(api.simulatePolicy).mockRejectedValue(
      new ApiErrorClass(400, "bad", "policy is broken"),
    );
    renderPage();
    await screen.findByTestId("policy-editor");

    await user.type(screen.getByLabelText(/^Name/), "my-policy");
    await user.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("policy is broken")),
    );
  });

  it("surfaces plain Error messages from save via toast.error", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const { toast } = await import("sonner");
    vi.mocked(api.savePolicy).mockRejectedValue(new Error("disk full"));
    renderPage();
    await screen.findByTestId("policy-editor");

    await user.type(screen.getByLabelText(/^Name/), "my-policy");
    await waitFor(() => expect(screen.getByText(/Syntax OK/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("disk full")),
    );
  });

  it("surfaces APIError messages from save via toast.error using userMessage", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const { toast } = await import("sonner");
    const ApiErrorClass = api.APIError as unknown as new (
      status: number,
      code: string,
      userMessage: string,
    ) => Error;
    vi.mocked(api.savePolicy).mockRejectedValue(
      new ApiErrorClass(409, "conflict", "version mismatch — pull first"),
    );
    renderPage();
    await screen.findByTestId("policy-editor");

    await user.type(screen.getByLabelText(/^Name/), "my-policy");
    await waitFor(() => expect(screen.getByText(/Syntax OK/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("version mismatch")),
    );
  });

  it("surfaces plain Error messages from simulate via toast.error", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    const { toast } = await import("sonner");
    vi.mocked(api.simulatePolicy).mockRejectedValue(new Error("simulator died"));
    renderPage();
    await screen.findByTestId("policy-editor");

    await user.type(screen.getByLabelText(/^Name/), "my-policy");
    await user.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("simulator died")),
    );
  });

  it("renders the policy source attribute as the title hover", async () => {
    const api = await import("@/lib/api");
    const summary = {
      name: "another",
      version: "v2def000000aaa",
      rules: 1,
    };
    vi.mocked(api.fetchPolicies).mockResolvedValue([summary]);
    renderPage();
    await waitFor(() => expect(screen.getByText("another")).toBeInTheDocument());
    const btn = screen.getByRole("button", { name: /another/i });
    expect(btn.getAttribute("title")).toBe("");
  });

  it("renders only validation errors when warnings is undefined", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.validatePolicy).mockResolvedValue({
      ok: false,
      errors: ["just an error"],
    });
    renderPage();
    await screen.findByTestId("policy-editor");
    await waitFor(() => expect(screen.getByText(/just an error/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  it("renders a no-constraints rule-set entry and skips the empty container badge", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.simulatePolicy).mockResolvedValue({
      policy: "bare",
      ruleSets: [{ name: "rs-empty", ports: [], allowlist: [], blocklist: [] }],
    });
    renderPage();
    await screen.findByTestId("policy-editor");

    await user.type(screen.getByLabelText(/^Name/), "bare");
    await user.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(screen.getByText(/Simulation: bare/i)).toBeInTheDocument());
    expect(screen.getByText("allow · tcp · all ports · from anywhere")).toBeInTheDocument();
  });

  it("renders the geo and rate-limit badges in a fully populated rule-set", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.simulatePolicy).mockResolvedValue({
      policy: "geo",
      ruleSets: [
        {
          name: "rs-geo",
          ports: [],
          allowlist: [],
          blocklist: [],
          geoAllow: ["US"],
          geoBlock: ["RU"],
          rateLimit: { rate: 50, burst: 5 },
        },
      ],
    });
    renderPage();
    await screen.findByTestId("policy-editor");

    await user.type(screen.getByLabelText(/^Name/), "geo");
    await user.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(screen.getByText(/Simulation: geo/i)).toBeInTheDocument());
    expect(
      screen.getByText(
        "allow · tcp · all ports · from anywhere · only countries US · blocked countries RU · limit 50/s, burst 5",
      ),
    ).toBeInTheDocument();
  });

  it("renders simulation errors from the response", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    vi.mocked(api.simulatePolicy).mockResolvedValue({
      policy: "errd",
      ruleSets: [],
      errors: ["bad rule"],
    });
    renderPage();
    await screen.findByTestId("policy-editor");

    await user.type(screen.getByLabelText(/^Name/), "errd");
    await user.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(screen.getByText(/bad rule/)).toBeInTheDocument());
    expect(screen.getByText(/produced no rules/i)).toBeInTheDocument();
  });

  it("derives the name from the policy text when the Name field is empty", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/api");
    renderPage();
    await screen.findByTestId("policy-editor");

    const nameInput = screen.getByLabelText(/^Name/);
    expect(nameInput).toHaveAttribute("placeholder", "e.g. web-public");
    expect(nameInput).toBeRequired();
    expect(screen.getByText(/Using "web-public" from the policy text/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(api.simulatePolicy).toHaveBeenCalled());
    expect(vi.mocked(api.simulatePolicy).mock.calls[0]?.[0]).toBe("web-public");
    expect(vi.mocked(api.simulatePolicy).mock.calls[0]?.[1]).toMatchObject({
      containerID: undefined,
    });
  });

  it("sends the policy for review and links to Approvals", async () => {
    const user = userEvent.setup();
    const cp = await import("@/lib/controlPlaneApi");
    const { toast } = await import("sonner");
    renderPage();
    await waitFor(() => expect(screen.getByText(/Syntax OK/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send for review" })).not.toBeDisabled(),
    );

    await user.click(screen.getByRole("button", { name: "Send for review" }));
    await waitFor(() => expect(cp.createApproval).toHaveBeenCalled());
    expect(vi.mocked(cp.createApproval).mock.calls[0]?.[0]).toMatchObject({
      policy_name: "web-public",
      requester: "alice",
    });
    expect(vi.mocked(cp.createApproval).mock.calls[0]?.[0].proposed_body).toContain(
      'policy "web-public"',
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("for review"), {
        description: expect.stringContaining("cannot be approved from this panel"),
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/cannot be approved from this panel/);
    expect(screen.getByRole("link", { name: "Open Approvals" })).toHaveAttribute(
      "href",
      "/approvals",
    );
  });

  it("toasts when sending for review fails", async () => {
    const user = userEvent.setup();
    const cp = await import("@/lib/controlPlaneApi");
    const { toast } = await import("sonner");
    vi.mocked(cp.createApproval).mockRejectedValue(new Error("control plane down"));
    renderPage();
    await waitFor(() => expect(screen.getByText(/Syntax OK/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("control plane down")),
    );
  });

  it("explains how to attach a saved policy to a container", async () => {
    renderPage();
    await screen.findByTestId("policy-editor");
    expect(screen.getByText(/firefik\.policy=<name>/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How this works" })).toHaveAttribute(
      "href",
      "/help/policies",
    );
  });
});
