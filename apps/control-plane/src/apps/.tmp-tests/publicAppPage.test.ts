import http from "node:http";
import events from "node:events";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright";
import { expect as ui } from "@playwright/test";
import { test } from "vitest";
import * as errore from "errore";
import { publicAppPage } from "../publicAppPage.js";

const browserTest = test.extend<{ page: Page }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest requires destructured fixture parameters.
  page: async ({}, use) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const server = http.createServer((request, response) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (request.headers["sec-fetch-dest"] === "iframe") {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end("<h1>Extension is usable</h1><button>Do work</button>");
        return;
      }
      publicAppPage({
        response,
        url,
        displayName: "Tasks <test>",
        publicOrigin: url.origin,
        head: false,
      });
    });
    server.listen(0, "127.0.0.1");
    await events.once(server, "listening");
    cleanup.defer(async () => {
      server.closeAllConnections();
      await new Promise<void>((complete) => server.close(() => complete()));
    });
    const browser = await chromium.launch({ headless: true });
    cleanup.defer(async () => await browser.close());
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    // SAFETY: The numeric TCP listener is ready.
    const address = server.address() as AddressInfo;
    await page.goto(`http://127.0.0.1:${address.port}/tasks/view/`);
    await use(page);
  },
});

browserTest(
  "banner submits the existing Buttondown list in a new tab and keeps the extension open",
  { timeout: 15_000 },
  async ({ page }) => {
    const app = page.frameLocator("iframe.app");
    await ui(
      app.getByRole("heading", { name: "Extension is usable" }),
    ).toBeVisible();
    ui(
      await page
        .locator("iframe.app")
        .evaluate(
          "document.querySelector('iframe.app').contentDocument.fullscreenEnabled",
        ),
    ).toBe(true);
    const email = page.getByRole("textbox", {
      name: "Email address",
      exact: true,
    });
    const submit = page.getByRole("button", {
      name: "Sign up for the waitlist",
    });
    await email.fill("invalid");
    await submit.click();
    await ui(page.getByRole("status")).toBeHidden();
    ui(page.context().pages()).toHaveLength(1);
    const context = page.context();
    await context.route(
      "https://buttondown.com/api/emails/embed-subscribe/halo",
      async (route) => {
        ui(route.request().method()).toBe("POST");
        const form = new URLSearchParams(route.request().postData()!);
        ui(form.get("email")).toBe("person@example.com");
        ui(form.get("embed")).toBe("1");
        // Control the external provider without submitting a real subscription.
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<h1>Confirm your signup</h1>",
        });
      },
    );
    await email.fill("person@example.com");
    const popupOpened = context.waitForEvent("page");
    await submit.click();
    const popup = await popupOpened;
    await ui(
      popup.getByRole("heading", { name: "Confirm your signup" }),
    ).toBeVisible();
    ui(await popup.evaluate("window.opener === null")).toBe(true);
    await ui(page.getByRole("status")).toHaveText(
      "Finish signing up in the new tab.",
    );
    await ui(email).toBeVisible();
    await app.getByRole("button", { name: "Do work" }).click();
  },
);
