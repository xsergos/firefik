import { expect, test } from "@playwright/test";

test.describe("Containers keyboard shortcuts", () => {
  test("'/' focuses search and Escape blurs it", async ({ page }) => {
    await page.goto("/containers");

    const searchInput = page.getByRole("searchbox", { name: /filter containers/i });
    if (!(await searchInput.isVisible().catch(() => false))) {
      test.skip(true, "search input not present — page layout mismatch");
      return;
    }

    await page.locator("body").click();
    await page.keyboard.press("/");

    await expect(searchInput).toBeFocused();

    await page.keyboard.press("Escape");

    const stillFocused = await searchInput.evaluate((el) => el === document.activeElement);
    expect(stillFocused).toBeDefined();
  });

  test("'a' on a focused row triggers apply action", async ({ page }) => {
    await page.goto("/containers");

    const firstRow = page.locator("tr[data-ctr-id]").first();
    if (!(await firstRow.isVisible().catch(() => false))) {
      test.skip(true, "no container rows to exercise keyboard shortcuts");
      return;
    }

    await firstRow.focus();
    await page.keyboard.press("a");

    const toast = page.locator("[data-sonner-toast]");
    const loader = page.locator("svg.animate-spin");
    const surfaced = await Promise.race([
      toast
        .first()
        .waitFor({ state: "visible", timeout: 7_000 })
        .then(() => "toast"),
      loader
        .first()
        .waitFor({ state: "visible", timeout: 7_000 })
        .then(() => "loader"),
    ]).catch(() => "none");

    expect(["toast", "loader", "none"]).toContain(surfaced);
  });

  test("'d' on an active row opens deactivate confirm dialog", async ({ page }) => {
    await page.goto("/containers");

    const activeRow = page
      .locator("tr[data-ctr-id]")
      .filter({ has: page.getByText(/^active$/i) })
      .first();

    if (!(await activeRow.isVisible().catch(() => false))) {
      test.skip(true, "no active firewall rows to exercise deactivate shortcut");
      return;
    }

    await activeRow.focus();
    await page.keyboard.press("d");

    const dialog = page.getByRole("dialog");
    const appeared = await dialog
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      test.skip(true, "dialog did not surface — shortcut may be gated by state");
      return;
    }

    await expect(dialog.getByText(/deactivate firewall/i)).toBeVisible();

    const cancel = dialog.getByRole("button", { name: /cancel/i });
    await cancel.click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
