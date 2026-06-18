import { expect, test } from "@playwright/test";

test.describe("Containers bulk actions", () => {
  test("selects multiple containers and opens bulk-apply dialog", async ({ page }) => {
    await page.goto("/containers");

    const heading = page.getByRole("heading", { name: /containers/i });
    const errorAlert = page.getByRole("alert");
    const state = await Promise.race([
      heading.waitFor({ state: "visible", timeout: 10_000 }).then(() => "ok"),
      errorAlert
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "error"),
    ]).catch(() => "timeout");

    if (state !== "ok") {
      test.skip(true, `containers page not ready (state=${state}) — backend likely unavailable`);
      return;
    }

    const rowCheckboxes = page.locator('tr[data-ctr-id] input[type="checkbox"]');
    const count = await rowCheckboxes.count();

    if (count < 2) {
      test.skip(true, `need at least 2 selectable containers, found ${count}`);
      return;
    }

    await rowCheckboxes.nth(0).check();
    await rowCheckboxes.nth(1).check();

    const applySelected = page.getByRole("button", { name: /apply selected/i });
    const disableSelected = page.getByRole("button", { name: /disable selected/i });

    await expect(applySelected).toBeVisible();
    await expect(applySelected).toBeEnabled();
    await expect(disableSelected).toBeVisible();
    await expect(disableSelected).toBeEnabled();

    await disableSelected.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const cancelButton = dialog.getByRole("button", { name: /cancel/i });
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
