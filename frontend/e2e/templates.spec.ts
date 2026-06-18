import { expect, test } from "@playwright/test";

test.describe("Templates page", () => {
  test("loads, lists templates from intercepted API, and shows the publish form", async ({
    page,
  }) => {
    await page.route("**/api/templates", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              name: "web-allow",
              version: 1,
              body: "policy 'web' { allow }",
              labels: { tier: "edge" },
              publisher: "alice",
              created_at: "2026-04-23T10:00:00Z",
              updated_at: "2026-04-23T10:05:00Z",
            },
          ]),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/templates");

    await expect(page.getByRole("heading", { name: /policy templates/i })).toBeVisible();
    await expect(page.getByText("web-allow")).toBeVisible();
    await expect(page.getByText("alice")).toBeVisible();
    await expect(page.getByPlaceholder("template-name")).toBeVisible();
    await expect(page.getByPlaceholder(/policy DSL body/i)).toBeVisible();

    const publishBtn = page.getByRole("button", { name: /^Publish$/ });
    await expect(publishBtn).toBeVisible();
    await expect(publishBtn).toBeDisabled();
  });
});
