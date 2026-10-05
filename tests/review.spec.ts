import { expect, test } from "@playwright/test";

test("shows unmeasured evaluation values and loads the example diff", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Review desk" })).toBeVisible();
  await expect(page.getByText("BugsJS review baseline")).toBeVisible();
  await expect(page.locator(".metric-cell").nth(0).locator("strong")).toHaveText("94.4–100.0%");
  await expect(page.locator(".metric-cell").nth(1).locator("strong")).toHaveText("28.8–30.5%");
  await expect(page.getByText("Unmeasured").first()).toBeVisible();
  await expect(page.locator(".metric-cell").nth(3).locator("strong")).toHaveText("2.5%");
  await expect(page.locator(".metric-cell").nth(3)).toContainText("1/40 seeded");
  await page.getByRole("button", { name: "Load example diff" }).click();
  await expect(page.getByRole("textbox", { name: "Unified diff" })).toContainText("Invoice not found");
});

test("keeps the review desk within a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(375);
});
