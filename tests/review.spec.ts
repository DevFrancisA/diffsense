import { expect, test } from "@playwright/test";

test("shows unmeasured evaluation values and loads the example diff", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Review desk" })).toBeVisible();
  await expect(page.getByText("Not measured").first()).toBeVisible();
  await page.getByRole("button", { name: "Load example diff" }).click();
  await expect(page.getByRole("textbox", { name: "Unified diff" })).toContainText("Invoice not found");
});

test("keeps the review desk within a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(375);
});
