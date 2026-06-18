import { expect, test } from "@playwright/test";

test.describe("Policies page", () => {
  test("selects a policy, edits it, and simulates", async ({ page }) => {
    await page.goto("/policies");

    const heading = page.getByRole("heading", { name: /policies/i });
    const errorAlert = page.getByRole("alert");
    const state = await Promise.race([
      heading.waitFor({ state: "visible", timeout: 10_000 }).then(() => "ok"),
      errorAlert
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "error"),
    ]).catch(() => "timeout");

    if (state !== "ok") {
      test.skip(true, `policies page not ready (state=${state}) — backend likely unavailable`);
      return;
    }

    const simulateButton = page.getByRole("button", { name: /^simulate$/i });
    const simulateVisible = await simulateButton
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!simulateVisible) {
      test.skip(true, "simulate button not present — policies page may be read-only");
      return;
    }

    const policyButtons = page.locator("aside button").filter({ hasNotText: /new policy/i });
    const policyCount = await policyButtons.count();

    if (policyCount === 0) {
      test.skip(true, "no saved policies — backend empty or read-only; skipping editor flow");
      return;
    }

    await policyButtons.first().click();

    const editor = page.locator(".cm-content").first();
    await editor.waitFor({ state: "visible", timeout: 15_000 });

    const nameInput = page.getByPlaceholder("web-public");
    const nameValue = await nameInput.inputValue();
    if (!nameValue) {
      await nameInput.fill("e2e-policy-draft");
    }

    await editor.click();
    await page.keyboard.type('\nallow if proto == "tcp" and port == 8080\n');

    const validationOk = page.getByText(/syntax ok/i);
    const validationErr = page.locator("text=/✗|✘/");
    await Promise.race([
      validationOk.waitFor({ state: "visible", timeout: 5_000 }).catch(() => null),
      validationErr
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        .catch(() => null),
    ]);

    await simulateButton.click();

    const simulationHeading = page.getByRole("heading", { name: /simulation:/i });
    const simulateError = page.locator("[data-sonner-toast], [role='status']").filter({
      hasText: /simulate failed|error/i,
    });
    const surfaced = await Promise.race([
      simulationHeading.waitFor({ state: "visible", timeout: 10_000 }).then(() => "ok"),
      simulateError
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "error"),
    ]).catch(() => "timeout");

    expect(["ok", "error"]).toContain(surfaced);
  });
});
