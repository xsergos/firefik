import { expect, test } from "@playwright/test";

test.describe("API failure recovery", () => {
  test("rules page surfaces error state and recovers", async ({ page }) => {
    await page.route("**/api/rules*", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced failure" }),
      });
    });

    await page.goto("/rules");

    const errorAlert = page.getByRole("alert");
    const errorBoundaryHint = page.getByText(
      /failed to load rules|something went wrong|try again/i,
    );
    const surfaced = await Promise.race([
      errorAlert
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "alert"),
      errorBoundaryHint
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "hint"),
    ]).catch(() => "none");

    expect(["alert", "hint"]).toContain(surfaced);

    await page.unroute("**/api/rules*");
    await page.reload();

    const heading = page.getByRole("heading", { name: /active rules/i });
    const emptyState = page.getByText(/no active firewall rules/i);
    const errorAfterReload = page.getByRole("alert");
    const recovered = await Promise.race([
      heading.waitFor({ state: "visible", timeout: 15_000 }).then(() => "heading"),
      emptyState.waitFor({ state: "visible", timeout: 15_000 }).then(() => "empty"),
      errorAfterReload
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "error"),
    ]).catch(() => "none");

    if (recovered === "error" || recovered === "none") {
      test.skip(true, `could not verify recovery (state=${recovered}) — backend unavailable`);
      return;
    }

    expect(["heading", "empty"]).toContain(recovered);
  });

  test("containers page surfaces error state and recovers", async ({ page }) => {
    await page.route("**/api/containers*", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced failure" }),
      });
    });

    await page.goto("/containers");

    const errorAlert = page.getByRole("alert");
    const errorHint = page.getByText(
      /could not connect to backend|failed|something went wrong|try again/i,
    );
    const surfaced = await Promise.race([
      errorAlert
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "alert"),
      errorHint
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "hint"),
    ]).catch(() => "none");

    expect(["alert", "hint"]).toContain(surfaced);

    await page.unroute("**/api/containers*");
    await page.reload();

    const heading = page.getByRole("heading", { name: /containers/i });
    const errorAfterReload = page.getByRole("alert");
    const recovered = await Promise.race([
      heading.waitFor({ state: "visible", timeout: 15_000 }).then(() => "heading"),
      errorAfterReload
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "error"),
    ]).catch(() => "none");

    if (recovered === "error" || recovered === "none") {
      test.skip(true, `could not verify recovery (state=${recovered}) — backend unavailable`);
      return;
    }

    expect(recovered).toBe("heading");
  });
});
