// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState(
    {},
    "",
    "/?utm_source=linkedin&utm_medium=social&utm_campaign=launch&email=private%40example.com&code=secret",
  );
  document.head.innerHTML =
    '<meta name="halo-ga-measurement-id" content="G-HALOTEST" />';
  sessionStorage.clear();
  // Google's script is not loaded in this DOM; its outbound queue is the boundary.
  Reflect.deleteProperty(window, "dataLayer");
});
afterEach(() => vi.restoreAllMocks());

function commands() {
  // SAFETY: marketingAnalytics writes Google's standard arguments queue here.
  const analyticsWindow = window as Window & { dataLayer?: IArguments[] };
  return (analyticsWindow.dataLayer ?? []).map((entry) => Array.from(entry));
}

test("sends one marketing page view with campaign attribution and no unrelated query data", async () => {
  const analytics = await import("./marketingAnalytics.js");
  analytics.trackMarketingPage();
  analytics.trackMarketingPage();
  expect(commands().filter((entry) => entry[1] === "page_view")).toHaveLength(
    1,
  );
  expect(commands()).toContainEqual([
    "config",
    "G-HALOTEST",
    expect.objectContaining({
      send_page_view: false,
      page_location: expect.stringContaining("utm_source=linkedin"),
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    }),
  ]);
  expect(JSON.stringify(commands())).not.toMatch(/private|secret|email=/);
  expect(
    document.querySelectorAll(
      'script[src^="https://www.googletagmanager.com/gtag/js"]',
    ),
  ).toHaveLength(1);
});

test.each([undefined, "", "G-invalid", "<script>"])(
  "does not load analytics without a valid deployment ID: %s",
  async (measurementId) => {
    if (measurementId === undefined) document.head.innerHTML = "";
    else document.querySelector("meta")!.setAttribute("content", measurementId);
    const analytics = await import("./marketingAnalytics.js");
    analytics.trackMarketingPage();
    analytics.trackMarketingEvent("booking_open");
    expect(commands()).toEqual([]);
    expect(document.querySelector("script")).toBeNull();
  },
);

test("records each fresh Cal booking once without sending booking details", async () => {
  const analytics = await import("./marketingAnalytics.js");
  analytics.trackMarketingPage();
  analytics.trackCallBooking(undefined);
  analytics.trackCallBooking("booking-one");
  analytics.trackCallBooking("booking-one");
  analytics.trackCallBooking("booking-two");
  const leads = commands().filter((entry) => entry[1] === "generate_lead");
  expect(leads).toEqual(
    Array.from({ length: 2 }, () => [
      "event",
      "generate_lead",
      { lead_type: "call_booking", method: "cal_com" },
    ]),
  );
  expect(JSON.stringify(commands())).not.toContain("booking-one");
});

test("counts an accepted waitlist form once, and keeps submissions separate from leads", async () => {
  const analytics = await import("./marketingAnalytics.js");
  analytics.trackWaitlistAccepted();
  expect(commands()).toEqual([]);
  analytics.trackMarketingPage();
  analytics.trackWaitlistSubmission();
  expect(commands().filter((entry) => entry[1] === "generate_lead")).toEqual(
    [],
  );
  expect(commands()).toContainEqual(["event", "waitlist_submit"]);
  window.history.replaceState({}, "", "/newsletter/check-email");
  analytics.trackWaitlistAccepted();
  analytics.trackWaitlistAccepted();
  expect(commands().filter((entry) => entry[1] === "generate_lead")).toEqual([
    [
      "event",
      "generate_lead",
      { lead_type: "waitlist_signup", method: "buttondown" },
    ],
  ]);
});

test("does not interrupt the form when browser storage is unavailable", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new DOMException("Storage disabled", "SecurityError");
  });
  vi.spyOn(sessionStorage, "getItem").mockImplementation(() => {
    throw new DOMException("Storage disabled", "SecurityError");
  });
  const analytics = await import("./marketingAnalytics.js");
  analytics.trackMarketingPage();
  expect(() => analytics.trackWaitlistSubmission()).not.toThrow();
  expect(() => analytics.trackWaitlistAccepted()).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(2);
  expect(commands()).toContainEqual(["event", "waitlist_submit"]);
});
