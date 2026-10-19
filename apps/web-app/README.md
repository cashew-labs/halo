# Halo marketing website

The public landing page offers a Cal.com early-access call and a Buttondown
waitlist. Google Analytics 4 measures visits and conversions on these marketing
pages. Production uses Measurement ID `G-87KZ9JXCVX`; other deployments remain disabled unless configured.

## Enable Google Analytics

1. In Google Analytics, select or create a GA4 property and a Web data stream for
   `https://gethalo.dev`. Copy its public Measurement ID (`G-…`).
2. Set `halo-control-plane:googleAnalyticsMeasurementId` in the production Pulumi
   stack. Pulumi passes it as `GOOGLE_ANALYTICS_MEASUREMENT_ID` to the control
   plane, which places the value in the HTML meta tag at request time. No browser
   rebuild is needed. Keep staging unset or use a separate test stream.
   Local development can set the environment variable directly; JSON server
   configurations use `googleAnalyticsMeasurementId`.
3. Turn off Enhanced Measurement for this stream. Halo sends its own marketing
   page views and form events; automatic history, form, and outbound-link events
   could duplicate them or include unrelated application URLs. Google signals
   and advertising personalization are disabled in the tag configuration.
4. Register `lead_type` as an event-scoped custom dimension. Mark
   `generate_lead` as a key event. Use its `lead_type` parameter to distinguish
   `call_booking` from `waitlist_signup` in reports.
5. In Buttondown, set `subscription_redirect_url` to
   `https://gethalo.dev/newsletter/check-email` and
   `subscription_confirmation_redirect_url` to
   `https://gethalo.dev/newsletter/joined`. Keep the native form submission so
   Buttondown can handle validation and CAPTCHA.
6. In GA's unwanted referrals settings, exclude `buttondown.com` so returning
   from the subscription form does not replace the acquisition source. Use
   Realtime or DebugView to verify a tagged landing visit and the two lead types.
   Use a test stream for test bookings and subscriptions.

The homepage tag loads only after the visitor is known to be signed out.
Newsletter return pages also load the tag; signed-in application routes do not. Its page location keeps
only the five supported campaign parameters; unrelated query strings and
fragments are excluded. Events do not include email addresses, names, Cal.com
booking payloads, or workspace content. The privacy policy describes analytics
and the booking provider. Configure any required consent controls before
activating analytics for an audience that needs them.

| Event                                        | Trigger                                                              | Meaning                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `page_view`                                  | Marketing page renders                                               | One view per page load, including React Strict Mode                                                    |
| `early_access_open`                          | Get early access is pressed                                          | Dialog opened                                                                                          |
| `booking_open`                               | Book a call is pressed                                               | Booking flow opened, not a conversion                                                                  |
| `waitlist_open`                              | Waitlist choice is pressed                                           | Waitlist form opened                                                                                   |
| `waitlist_submit`                            | Valid form submits                                                   | Attempt, not yet accepted by Buttondown                                                                |
| `generate_lead`, `lead_type=call_booking`    | Cal.com's `bookingSuccessfulV2` event                                | New booking created, deduplicated by UID for the current page; Cal may still require host confirmation |
| `generate_lead`, `lead_type=waitlist_signup` | Buttondown returns to check-email after a form submitted in this tab | Accepted signup, before email confirmation; marker is consumed to prevent reload counts                |
| `waitlist_confirmation_view`                 | Joined page renders                                                  | Browser confirmation-page view, not server-verified double opt-in                                      |

Browser analytics is best-effort. Blocking analytics prevents GA reporting;
blocking session storage also prevents the accepted-waitlist event. Cal.com and
Buttondown remain the authoritative records. Email confirmation on another
browser cannot reliably be joined to the original GA visitor; verified
cross-device conversion reporting would need provider webhooks and server-side
measurement.

## Custom shortener at go.gethalo.dev

The custom **hosted Halo extension** will own link storage and the agent API.
There is no third-party shortening provider and no management UI. The public
website only needs the GA integration above to attribute visits and conversions.

A short link must redirect to a tagged destination such as:

```
https://gethalo.dev/?utm_source=linkedin&utm_medium=social&utm_campaign=launch
```

Use `utm_source`, `utm_medium`, and `utm_campaign` consistently; optionally add
`utm_content` and `utm_term`. The landing page forwards these five fields into
Cal.com's booking configuration and Buttondown's `metadata__utm_*` fields.
Google Analytics reads the tags on the destination, so the shortener does not
need a GA tag for this flow.

Before the shortener can run, its deployment must:

- Reserve `go` for the Halo marketing service so a normal creator cannot claim
  the trusted hostname.
- Route `go.gethalo.dev/:slug` to that one hosted extension's public resolution
  endpoint and return an HTTP redirect. The current app gateway exposes
  `/<app>/view`, `/api`, and `/sync`; it does not yet map short paths to an
  extension. A CNAME alone does not add that mapping.
- Verify DNS and HTTPS for `go.gethalo.dev`. The control-plane infrastructure
  declares wildcard creator DNS and certificates; check that they are active
  before adding a record. If a separate ingress is chosen, configure its DNS
  target and certificate instead.
- Keep link creation, editing, listing, and deletion behind an explicit Halo
  admin authorization check or narrowly scoped admin-agent credentials. An
  extension owner/member role is not a Halo administrator role. Expose only
  destination lookup to anonymous visitors and block public storage sync.
- Keep the published extension available independently of desktop sessions.

This PR does not deploy the extension, reserve `go`, configure its DNS, or add
its hostname-to-extension route. Those require the actual extension and its
hosting target. Do not point DNS at an ordinary creator app and assume short
paths or admin protections are provided automatically.

## References

- [Google campaign parameters](https://support.google.com/analytics/answer/10917952)
- [Cal.com embed events](https://cal.com/help/embedding/embed-events)
- [Cal.com campaign tracking](https://cal.com/help/bookings/utm-tracking)
- [Buttondown native forms and metadata](https://docs.buttondown.com/building-your-subscriber-base)
- [Buttondown redirect settings](https://docs.buttondown.com/api-newsletters-update)
