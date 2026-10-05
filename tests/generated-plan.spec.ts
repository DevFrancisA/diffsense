import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

type Step = { action: string; selector: string; value: string; expected: string };
type Scenario = { title: string; purpose: string; steps: Step[] };

const planPath = process.env.DIFFSENSE_TEST_PLAN ?? resolve("tests/fixtures/generated-plan.json");
const plan = JSON.parse(readFileSync(planPath, "utf8")) as { scenarios: Scenario[] };

for (const scenario of plan.scenarios) {
  test(`generated plan: ${scenario.title}`, async ({ page }) => {
    for (const [index, step] of scenario.steps.entries()) {
      await test.step(`plan step ${index}: ${step.action}`, async () => {
        switch (step.action) {
          case "goto":
            if (!step.value.startsWith("/") || step.value.startsWith("//")) throw new Error("Plan navigation must stay on the configured origin.");
            await page.goto(step.value);
            break;
          case "click":
            await page.locator(step.selector).click();
            break;
          case "fill":
            await page.locator(step.selector).fill(step.value);
            break;
          case "expectVisible":
            await expect(page.locator(step.selector)).toBeVisible();
            break;
          case "expectText":
            await expect(page.locator(step.selector)).toContainText(step.expected);
            break;
          case "expectValue":
            await expect(page.locator(step.selector)).toHaveValue(step.expected);
            break;
          case "expectValueContains":
            await expect.poll(() => page.locator(step.selector).inputValue()).toContain(step.expected);
            break;
          case "expectUrl":
            expect(new URL(page.url()).pathname).toContain(step.expected);
            break;
          default:
            throw new Error(`Unsupported generated action: ${step.action}`);
        }
      });
    }
  });
}
