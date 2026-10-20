import * as errore from "errore";

const campaignKeys = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;
const waitlistSubmissionKey = "halo.waitlist.submitted";

class MarketingStorageError extends errore.createTaggedError({
  name: "MarketingStorageError",
  message: "Could not $operation waitlist tracking state.",
}) {}

type MarketingEvent =
  | "early_access_open"
  | "booking_open"
  | "waitlist_open"
  | "waitlist_submit"
  | "waitlist_confirmation_view";
type GoogleTag = (
  ...args:
    | ["js", Date]
    | [
        "config",
        string,
        {
          send_page_view: boolean;
          page_location: string;
          page_referrer: string;
          page_title: string;
          allow_google_signals: boolean;
          allow_ad_personalization_signals: boolean;
        },
      ]
    | ["event", string, { lead_type: string; method: string }?]
) => void;

// Only marketing components call this module. No workspace data enters GA.
let googleTag: GoogleTag | undefined;
const viewedPages = new Set<string>();
const recordedBookings = new Set<string>();

export function marketingCampaign() {
  const query = new URLSearchParams(window.location.search);
  return Object.fromEntries(
    campaignKeys.flatMap((key) => {
      const value = query.get(key);
      return value === null ? [] : [[key, value]];
    }),
  );
}

function initializeGoogleTag() {
  if (googleTag !== undefined) return googleTag;
  const measurementId =
    document
      .querySelector('meta[name="halo-ga-measurement-id"]')
      ?.getAttribute("content") ?? undefined;
  if (measurementId === undefined || !/^G-[A-Z0-9]+$/.test(measurementId))
    return;

  // SAFETY: dataLayer is the Google tag's documented global queue of arguments.
  const analyticsWindow = window as Window & { dataLayer?: IArguments[] };
  const dataLayer = (analyticsWindow.dataLayer ??= []);
  const tag: GoogleTag = function (..._args) {
    // Google's queue consumes Arguments objects, as in the official snippet.
    dataLayer.push(arguments);
  };
  googleTag = tag;
  tag("js", new Date());
  const location = new URL(window.location.pathname, window.location.origin);
  location.search = new URLSearchParams(marketingCampaign()).toString();
  tag("config", measurementId, {
    send_page_view: false,
    page_location: location.href,
    // Auth codes and email addresses in query strings must never enter GA.
    page_referrer: document.referrer.split(/[?#]/)[0],
    page_title: "Halo",
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.append(script);
  return tag;
}

export function trackMarketingPage() {
  const tag = initializeGoogleTag();
  const pathname = window.location.pathname;
  if (tag === undefined || viewedPages.has(pathname)) return false;
  viewedPages.add(pathname);
  tag("event", "page_view");
  return true;
}

export function trackMarketingEvent(event: MarketingEvent) {
  googleTag?.("event", event);
}

export function trackCallBooking(bookingUid: string | undefined) {
  if (bookingUid === undefined || recordedBookings.has(bookingUid)) return;
  recordedBookings.add(bookingUid);
  googleTag?.("event", "generate_lead", {
    lead_type: "call_booking",
    method: "cal_com",
  });
}

// coverage-exempt: Browser source maps omit this event-handler declaration; native form submission and the function body are tested.
export function trackWaitlistSubmission() {
  trackMarketingEvent("waitlist_submit");
  const saved = errore.try({
    try: () => sessionStorage.setItem(waitlistSubmissionKey, "pending"),
    catch: (cause) => new MarketingStorageError({ operation: "save", cause }),
  });
  if (saved instanceof Error) console.warn(saved);
}

export function trackWaitlistAccepted() {
  // Runs once Buttondown accepts the background submission, or on its
  // check-email return page after a native fallback, before double opt-in.
  // Consume the marker so reloads and direct visits do not create more leads.
  const pending = errore.try({
    try: () => {
      const value = sessionStorage.getItem(waitlistSubmissionKey);
      sessionStorage.removeItem(waitlistSubmissionKey);
      return value;
    },
    catch: (cause) => new MarketingStorageError({ operation: "read", cause }),
  });
  if (pending instanceof Error) {
    console.warn(pending);
    return;
  }
  if (pending !== "pending") return;
  googleTag?.("event", "generate_lead", {
    lead_type: "waitlist_signup",
    method: "buttondown",
  });
}
