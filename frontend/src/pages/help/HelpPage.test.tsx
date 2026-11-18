import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import HelpPage from "./HelpPage";
import { HELP_SECTIONS } from "./registry";

let panelMode = true;
vi.mock("@/lib/panelMode", () => ({
  get isPanelMode() {
    return panelMode;
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/help" element={<HelpPage />} />
        <Route path="/help/:section" element={<HelpPage />} />
        <Route path="/" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  panelMode = true;
});

describe("HelpPage", () => {
  it("opens the first section from /help", () => {
    renderAt("/help");
    expect(screen.getByRole("heading", { name: "Firefik in one minute" })).toBeInTheDocument();
    expect(screen.getByText(`1 / ${HELP_SECTIONS.length}`)).toBeInTheDocument();
  });

  it("walks to the next section", async () => {
    renderAt("/help/overview");
    await userEvent.setup().click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByRole("heading", { name: "Reading the Fleet page" })).toBeInTheDocument();
  });

  it("jumps to a section from the Sections picker", async () => {
    renderAt("/help/overview");
    await userEvent
      .setup()
      .selectOptions(screen.getByRole("combobox", { name: "Sections" }), "traffic");
    expect(screen.getByRole("heading", { level: 2, name: /Who is knocking/ })).toBeInTheDocument();
  });

  it("scrolls the main area back to the top when the section changes", async () => {
    const scrollTo = vi.fn();
    render(
      <main>
        <MemoryRouter initialEntries={["/help/overview"]}>
          <Routes>
            <Route path="/help/:section" element={<HelpPage />} />
          </Routes>
        </MemoryRouter>
      </main>,
    );
    const main = screen.getByRole("main");
    main.scrollTo = scrollTo;
    await userEvent.setup().click(screen.getByRole("button", { name: /Next/ }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("uses the Add agent page's field labels in the Adding a new host picture", () => {
    const { container } = renderAt("/help/add-host");
    const text = container.textContent ?? "";
    for (const label of [
      "Instance ID",
      "Code expires after (minutes)",
      "Enrollment address",
      "Agent connection address",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).not.toMatch(/CP (HTTP|gRPC) endpoint/);
  });

  it("redirects unknown sections to the start", () => {
    renderAt("/help/nope");
    expect(screen.getByRole("heading", { name: "Firefik in one minute" })).toBeInTheDocument();
  });

  it("hides panel-only sections on a single agent", () => {
    panelMode = false;
    renderAt("/help/overview");
    expect(screen.queryAllByRole("link", { name: /Reading the Fleet page/ })).toHaveLength(0);
    expect(screen.getAllByRole("link", { name: /Who is knocking/ }).length).toBeGreaterThan(0);
  });

  it.each(HELP_SECTIONS.map((s) => [s.id, s.title]))("renders section %s", (id, title) => {
    renderAt(`/help/${id}`);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent?.startsWith(title)).toBe(true);
  });
});
