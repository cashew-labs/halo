import { expect, test } from "vitest";
import { connectionRequestLabel } from "@get-halo/shared/ConnectionRequest";
import { googleIntegrationDisplay } from "@get-halo/shared/GoogleIntegrationDisplay";

test("google calendar display is a product name and a human capability line", () => {
  expect(googleIntegrationDisplay("google_calendar")).toEqual({
    name: "Google Calendar",
    description: "Create, find, and update events on your calendars.",
  });
});

test("gmail display uses the product name rather than a title-cased slug", () => {
  expect(googleIntegrationDisplay("google_gmail")).toEqual({
    name: "Gmail",
    description: "Read, send, and organize your email.",
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

test("unknown integrations have no display copy", () => {
  expect(googleIntegrationDisplay("unknown_service")).toBeUndefined();
});
