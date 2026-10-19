import { expect } from "@playwright/test";
import { marketingTest as test, marketingEvents as events, marketingOrigin as origin } from "../fixtures.js";

test("keeps analytics disabled without the deployment tag while the access flow remains usable", async ({ marketing: page }) => {
  await page.route(`${origin}/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('content="G-HALOTEST"', 'content=""') });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Get early access", exact: true }).click();
  await page.getByRole("button", { name: "Join the waitlist instead" }).click();
  await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
  expect(await events(page)).toEqual([]);
  await expect(page.locator('script[src*="googletagmanager.com"]')).toHaveCount(0);
});

test("a direct visit to the waitlist success page is not a signup", async ({ marketing: page }) => {
  await page.goto("/newsletter/check-email");
  await expect(page.getByRole("heading", { name: "Check your email to confirm your subscription." })).toBeVisible();
  await expect.poll(async () => (await events(page)).filter((entry) => entry[1] === "page_view").length).toBe(1);
  expect((await events(page)).filter((entry) => entry[1] === "generate_lead")).toEqual([]);
});

test("closing the booking dialog restores the choice step and does not create a lead", async ({ marketing: page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Get early access", exact: true }).click();
  await page.getByRole("button", { name: "Book a call", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Get early access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Get early access", exact: true })).toBeVisible();
  expect((await events(page)).filter((entry) => entry[1] === "generate_lead")).toEqual([]);
});
