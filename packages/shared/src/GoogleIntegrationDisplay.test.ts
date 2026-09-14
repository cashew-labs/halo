import { expect, test } from "vitest";
import { connectionRequestLabel } from "@get-halo/shared/ConnectionRequest";
import { googleIntegrationDisplay } from "@get-halo/shared/GoogleIntegrationDisplay";

test("google calendar display is a product name, capability line, and product icon", () => {
  expect(googleIntegrationDisplay("google_calendar")).toEqual({
    name: "Google Calendar",
    description: "Search events and schedule meetings.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v8/192px.svg",
  });
});

test("gmail display uses the product name rather than a title-cased slug", () => {
  expect(googleIntegrationDisplay("google_gmail")).toEqual({
    name: "Gmail",
    description: "Search, read, draft, and manage email.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v8/web-96dp/logo_gmail_2020q4_color_2x_web_96dp.png",
  });
  expect(
    connectionRequestLabel({
      client: "first-party:google",
      clientOwner: "org",
      owner: "user",
      connectionName: "default",
      integration: "google_gmail",
      template: "googleOAuth2",
    }),
  ).toBe("Gmail");
});

test("drive and bigquery use the cursor plugin capability lines", () => {
  expect(googleIntegrationDisplay("google_drive")?.description).toBe(
    "Search, read, create, and share files.",
  );
  expect(googleIntegrationDisplay("google_bigquery")?.description).toBe(
    "Explore datasets and tables and run SQL queries.",
  );
});

test("unknown integrations have no display copy", () => {
  expect(googleIntegrationDisplay("unknown_service")).toBeUndefined();
});
