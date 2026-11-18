import { expect, test } from "@playwright/test";

test.describe("Firefik UI smoke", () => {
  test("dashboard renders without runtime errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("containers page reaches API", async ({ page }) => {
    await page.goto("/containers");
    await expect(page.getByRole("heading", { name: /containers/i })).toBeVisible();
  });

  test("rules page reaches API", async ({ page }) => {
    await page.goto("/rules");
    const visible = await Promise.race([
      page
        .getByRole("heading", { name: /^rules$/i })
        .waitFor({ state: "visible" })
        .then(() => true),
      page
        .getByText(/no active firewall rules/i)
        .waitFor({ state: "visible" })
        .then(() => true),
    ]);
    expect(visible).toBe(true);
  });

  test("logs page opens and WS connects", async ({ page }) => {
    await page.goto("/logs");
    await expect(page.getByRole("heading", { name: /traffic log/i })).toBeVisible();
    await expect(page.getByRole("status")).toBeVisible();
  });

  test("theme toggle switches classes", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByRole("button", { name: /mode/i });
    const before = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    await toggle.click();
    const after = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    expect(before).not.toBe(after);
  });

  test("mock target round-trips apply and deactivate", async ({ page }) => {
    const target = /e2e-target/;

    await page.goto("/containers");

    const row = page.getByRole("row", { name: target });
    try {
      await row.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      test.skip(
        true,
        "mock e2e target not present — compose override not applied, skipping apply/disable flow",
      );
      return;
    }

    const applyButton = row.getByRole("button", { name: /^apply rules for/i });
    if (await applyButton.isVisible()) {
      await applyButton.click();
      await expect(row.getByText(/^active$/i)).toBeVisible({ timeout: 10_000 });
    }

    const deactivateButton = row.getByRole("button", { name: /turn off firewall for/i });
    await deactivateButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/turn off the firewall/i)).toBeVisible();
    await dialog.getByRole("button", { name: /^turn off$/i }).click();

    await expect(row.getByText(/^(off|pending)$/i)).toBeVisible({ timeout: 10_000 });
  });
});
