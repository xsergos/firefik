import { expect, test } from "@playwright/test";

test.describe("Approvals page", () => {
  test("loads, renders pending cards, and switches filters", async ({ page }) => {
    const pending = [
      {
        id: "ap-pending",
        policy_name: "web-allow",
        proposed_body: "policy 'web' { allow }",
        requester: "bob",
        requester_fingerprint: "sha256:bob",
        requested_at: "2026-04-23T10:00:00Z",
        approver: "",
        approver_fingerprint: "",
        approved_at: null,
        status: "pending",
        rejection_comment: "",
      },
    ];
    const approved = [
      {
        id: "ap-approved",
        policy_name: "db-deny",
        proposed_body: "policy 'db' { deny }",
        requester: "carol",
        requester_fingerprint: "sha256:carol",
        requested_at: "2026-04-22T10:00:00Z",
        approver: "alice",
        approver_fingerprint: "sha256:alice",
        approved_at: "2026-04-22T11:00:00Z",
        status: "approved",
        rejection_comment: "",
      },
    ];

    await page.route("**/api/approvals*", async (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get("status");
      const body = status === "approved" ? approved : status === "rejected" ? [] : pending;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await page.goto("/approvals");

    await expect(page.getByRole("heading", { name: /^approvals$/i })).toBeVisible();
    await expect(page.getByText("web-allow")).toBeVisible();
    await expect(page.getByRole("button", { name: "pending" })).toBeVisible();
    await expect(page.getByRole("button", { name: "approved" })).toBeVisible();
    await expect(page.getByRole("button", { name: "rejected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "all" })).toBeVisible();

    await page.getByRole("button", { name: "approved" }).click();
    await expect(page.getByText("db-deny")).toBeVisible();

    await page.getByRole("button", { name: "rejected" }).click();
    await expect(page.getByText(/No approvals match the selected status/i)).toBeVisible();
  });
});
