import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PolicyTemplate } from "@/lib/controlPlaneApi";
import TemplatesPage from "./TemplatesPage";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/lib/controlPlaneApi", () => ({
  fetchTemplates: vi.fn(),
  publishTemplate: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <TemplatesPage />
      </QueryClientProvider>,
    ),
  };
}

const tplA: PolicyTemplate = {
  name: "web-allow",
  version: 1,
  body: "policy 'web' { allow }",
  labels: { tier: "edge" },
  publisher: "alice",
  created_at: "2026-04-23T10:00:00Z",
  updated_at: "2026-04-23T10:05:00Z",
};

const tplB: PolicyTemplate = {
  name: "db-deny",
  version: 2,
  body: "policy 'db' { deny }",
  labels: null,
  publisher: "",
  created_at: "2026-04-23T09:00:00Z",
  updated_at: "2026-04-23T09:05:00Z",
};

beforeEach(async () => {
  const api = await import("@/lib/controlPlaneApi");
  vi.mocked(api.fetchTemplates).mockResolvedValue([tplA, tplB]);
  vi.mocked(api.publishTemplate).mockResolvedValue(tplA);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TemplatesPage", () => {
  it("renders the list of templates from the API", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());
    expect(screen.getByText("db-deny")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("tier=edge")).toBeInTheDocument();
  });

  it("shows the empty state when API returns []", async () => {
    const api = await import("@/lib/controlPlaneApi");
    vi.mocked(api.fetchTemplates).mockResolvedValue([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No templates published yet/i)).toBeInTheDocument(),
    );
  });

  it("renders the loading state spinner before the query resolves", async () => {
    const api = await import("@/lib/controlPlaneApi");
    let resolveFn: (v: PolicyTemplate[]) => void = () => undefined;
    vi.mocked(api.fetchTemplates).mockReturnValue(
      new Promise<PolicyTemplate[]>((res) => {
        resolveFn = res;
      }),
    );
    renderPage();
    expect(screen.getByRole("status")).toBeInTheDocument();
    resolveFn([]);
    await waitFor(() =>
      expect(screen.getByText(/No templates published yet/i)).toBeInTheDocument(),
    );
  });

  it("renders the error state with the error message", async () => {
    const api = await import("@/lib/controlPlaneApi");
    vi.mocked(api.fetchTemplates).mockRejectedValue(new Error("network down"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/network down/i)).toBeInTheDocument();
  });

  it("disables the publish button when name or body is empty", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    const publishBtn = screen.getByRole("button", { name: /^Publish$/ });
    expect(publishBtn).toBeDisabled();

    await user.type(screen.getByPlaceholderText("template-name"), "new-tpl");
    expect(publishBtn).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/policy DSL body/i), "policy body content");
    expect(publishBtn).toBeEnabled();
  });

  it("calls publishTemplate, shows a success toast, and invalidates the query", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/controlPlaneApi");
    const { toast } = await import("sonner");
    const { qc } = renderPage();
    const spy = vi.spyOn(qc, "invalidateQueries");

    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("template-name"), "new-tpl");
    await user.type(screen.getByPlaceholderText(/policy DSL body/i), "policy body content");
    await user.click(screen.getByRole("button", { name: /^Publish$/ }));

    await waitFor(() =>
      expect(api.publishTemplate).toHaveBeenCalledWith({
        name: "new-tpl",
        body: "policy body content",
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Template published"));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["templates"] });
  });

  it("shows an error toast when publish fails", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/controlPlaneApi");
    const { toast } = await import("sonner");
    vi.mocked(api.publishTemplate).mockRejectedValue(new Error("forbidden"));
    renderPage();
    await waitFor(() => expect(screen.getByText("web-allow")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("template-name"), "new-tpl");
    await user.type(screen.getByPlaceholderText(/policy DSL body/i), "policy body content");
    await user.click(screen.getByRole("button", { name: /^Publish$/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("forbidden"));
  });
});
