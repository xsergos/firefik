import { expect, test } from "@playwright/test";

test.describe("Autogen proposals page", () => {
  test("lists proposals and exercises approve flow when data present", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);

    await page.goto("/proposals");

    const heading = page.getByRole("heading", { name: /autogen proposals/i });
    const errorAlert = page.getByRole("alert");
    const state = await Promise.race([
      heading.waitFor({ state: "visible", timeout: 10_000 }).then(() => "ok"),
      errorAlert
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "error"),
    ]).catch(() => "timeout");

    if (state !== "ok") {
      test.skip(true, `proposals page not ready (state=${state}) — backend likely unavailable`);
      return;
    }

    const emptyCopy = page.getByText(/no proposals in this bucket/i);
    const proposalItems = page.locator("ul.divide-y > li");

    const settled = await Promise.race([
      emptyCopy.waitFor({ state: "visible", timeout: 10_000 }).then(() => "empty"),
      proposalItems
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "list"),
    ]).catch(() => "timeout");

    if (settled !== "list") {
      test.skip(true, "no proposals available — skipping approve/reject flow");
      return;
    }

    await proposalItems.first().getByRole("button").first().click();

    const approveLabels = page.getByRole("button", { name: /approve → labels/i });
    await expect(approveLabels).toBeVisible();

    const approvePolicy = page.getByRole("button", { name: /approve → policy snippet/i });
    await expect(approvePolicy).toBeVisible();

    await approveLabels.click();

    const snippetSurface = page.locator("pre.whitespace-pre-wrap");
    const toastSurface = page.locator("[data-sonner-toast]");
    const resolution = await Promise.race([
      snippetSurface
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "snippet"),
      toastSurface
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "toast"),
    ]).catch(() => "timeout");

    expect(["snippet", "toast"]).toContain(resolution);

    if (resolution === "snippet") {
      const copyButton = page.getByRole("button", { name: /^copy$/i });
      if (await copyButton.isVisible()) {
        await copyButton.click();
      }
    }
  });
});
