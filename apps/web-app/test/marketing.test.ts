import { expect } from "@playwright/test";
import {
  marketingTest as test,
  marketingEvents as events,
  marketingOrigin as origin,
} from "./fixtures.js";

test("reports a new booking once and forwards marketing campaign tags", async ({
  marketing: page,
}) => {
  await page.goto(
    "/?utm_source=linkedin&utm_medium=social&utm_campaign=launch",
  );
  await page
    .getByRole("button", { name: "Get early access", exact: true })
    .click();
  await page.getByRole("button", { name: "Book a call", exact: true }).click();
  await expect
    .poll(async () =>
      (await events(page)).some((entry) => entry[1] === "page_view"),
    )
    .toBe(true);
  const frame = page.frameLocator('iframe[title="Book a call"]');
  await frame.getByRole("button", { name: "Book test call" }).click();
  await frame.getByRole("button", { name: "Book test call" }).click();
  await expect
    .poll(async () =>
      (await events(page)).filter((entry) => entry[1] === "generate_lead"),
    )
    .toEqual([
      [
        "event",
        "generate_lead",
        { lead_type: "call_booking", method: "cal_com" },
      ],
    ]);
  const iframe = page.locator('iframe[title="Book a call"]');
  expect(await iframe.getAttribute("src")).toContain("utm_source=linkedin");
  expect(await iframe.getAttribute("src")).toContain("utm_campaign=launch");
  await page.getByRole("button", { name: "Join the waitlist instead" }).click();
  await page.getByRole("button", { name: "Book a call instead" }).click();
  await frame.getByRole("button", { name: "Book test call" }).click();
  expect(
    (await events(page)).filter((entry) => entry[1] === "generate_lead"),
  ).toHaveLength(1);
});

test("reports an accepted waitlist signup after the native form returns, without reload duplicates", async ({
  marketing: page,
}) => {
  await page.goto(
    "/?utm_source=newsletter&utm_medium=email&utm_campaign=launch&email=private%40example.com",
  );
  await page
    .getByRole("button", { name: "Get early access", exact: true })
    .click();
  await page.getByRole("button", { name: "Join the waitlist instead" }).click();
  await page
    .getByRole("button", { name: "Join waitlist", exact: true })
    .click();
  expect(
    (await events(page)).some((entry) => entry[1] === "waitlist_submit"),
  ).toBe(false);
  await page
    .getByRole("textbox", { name: "Email address" })
    .fill("test@example.com");
  let submitted = new URLSearchParams();
  await page.route(
    "https://buttondown.com/api/emails/embed-subscribe/halo",
    async (route) => {
      submitted = new URLSearchParams(route.request().postData() ?? "");
      await route.fulfill({
        status: 303,
        headers: { location: `${origin}/newsletter/check-email` },
      });
    },
  );
  await page
    .getByRole("button", { name: "Join waitlist", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Check your email to confirm your subscription.",
    }),
  ).toBeVisible();
  expect(submitted.get("email")).toBe("test@example.com");
  expect(submitted.get("metadata__utm_source")).toBe("newsletter");
  expect(submitted.has("metadata__email")).toBe(false);
  await expect
    .poll(async () =>
      (await events(page)).filter((entry) => entry[1] === "generate_lead"),
    )
    .toEqual([
      [
        "event",
        "generate_lead",
        { lead_type: "waitlist_signup", method: "buttondown" },
      ],
    ]);
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Check your email to confirm your subscription.",
    }),
  ).toBeVisible();
  expect(
    (await events(page)).filter((entry) => entry[1] === "generate_lead"),
  ).toEqual([]);
  await page.goto("/newsletter/joined");
  await expect(
    page.getByRole("heading", { name: "You're on the list." }),
  ).toBeVisible();
  expect(
    (await events(page)).filter(
      (entry) => entry[1] === "waitlist_confirmation_view",
    ),
  ).toHaveLength(1);
});

test("does not load GA while authentication is pending or for the signed-in application", async ({
  marketing: page,
}) => {
  let finishSession: (() => void) | undefined;
  const releaseSession = new Promise<void>((resolve) => {
    finishSession = resolve;
  });
  await page.route(`${origin}/rpc/auth/session**`, async (route) => {
    await releaseSession;
    await route.fulfill({
      json: {
        json: {
          status: "signed-in",
          session: {
            session: {
              id: "session-test",
              userId: "user-test",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            user: {
              id: "user-test",
              email: "private@example.com",
              name: "Private user",
            },
          },
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Get early access", exact: true }),
  ).toBeVisible();
  await expect(page.locator('script[src*="googletagmanager.com"]')).toHaveCount(
    0,
  );
  expect(await events(page)).toEqual([]);
  finishSession!();
  await expect(page.getByRole("main", { name: "Halo home" })).not.toBeVisible();
  await expect(page.locator('script[src*="googletagmanager.com"]')).toHaveCount(
    0,
  );
  expect(await events(page)).toEqual([]);
});
