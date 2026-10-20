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
   `https://gethalo.dev/newsletter/joined`. The dialog posts the form in the
   background and confirms the signup in place. Its response is opaque, so a
   Buttondown rejection still looks sent. If the request fails, the dialog falls
   back to the native form submission and this return page.
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

| Event                                        | Trigger                                                                                                  | Meaning                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `page_view`                                  | Marketing page renders                                                                                   | One view per page load, including React Strict Mode                                                    |
| `early_access_open`                          | Get early access is pressed                                                                              | Dialog opened                                                                                          |
| `booking_open`                               | Book a call is pressed                                                                                   | Booking flow opened, not a conversion                                                                  |
| `waitlist_open`                              | Waitlist choice is pressed                                                                               | Waitlist form opened                                                                                   |
| `waitlist_submit`                            | Valid form submits                                                                                       | Attempt, not yet accepted by Buttondown                                                                |
| `generate_lead`, `lead_type=call_booking`    | Cal.com's `bookingSuccessfulV2` event                                                                    | New booking created, deduplicated by UID for the current page; Cal may still require host confirmation |
| `generate_lead`, `lead_type=waitlist_signup` | Buttondown accepts the dialog's background submission, or returns to check-email after a native fallback | Signup sent to Buttondown, before email confirmation; counted once per submission in this tab          |
| `waitlist_confirmation_view`                 | Joined page renders                                                                                      | Browser confirmation-page view, not server-verified double opt-in                                      |

Browser analytics is best-effort. Blocking analytics prevents GA reporting;
blocking session storage also prevents the accepted-waitlist event. Cal.com and
Buttondown remain the authoritative records. Email confirmation on another
browser cannot reliably be joined to the original GA visitor; verified
cross-device conversion reporting would need provider webhooks and server-side
measurement.

## Custom shortener at go.gethalo.dev

Halo's regular control-plane server owns `go.<control-plane-host>/:slug`.
It returns a 302 to the Halo homepage with the link's configured campaign tags.
No hosted extension, workspace, or signed-in desktop session participates.
`go` is reserved and cannot be claimed as a creator handle.

Campaigns are persistent control-plane database records. Authorized Halo admins
and their workspace agents manage them through `marketing.create/list/update/remove`
on the primary Halo RPC origin. Link changes require no deployment. No campaign
is enabled by default; create one before distributing its URL. See the
[admin API guide](../control-plane/README.marketing-links.md) for authorization,
agent examples, slug rules and UTM validation.

For example, an administrator can create `linkedin-launch` with `utm_source=linkedin`,
`utm_medium=social` and `utm_campaign=launch`. It resolves to
`https://gethalo.dev/?utm_source=linkedin&utm_medium=social&utm_campaign=launch`.
Every campaign points to the homepage. Required tags are `utm_source`, `utm_medium`
and `utm_campaign`; content and term are optional. Disabled/deleted campaigns
stop resolving immediately.
GET and HEAD resolve enabled slugs, with an optional trailing slash. Unknown
paths return 404; other methods return 405. Responses are not cached. Visitor
query strings never replace the saved tags or destination. No authenticated
Halo routes or extension sync/API surfaces are served on this host.

The existing landing page forwards these five tags into Cal.com and Buttondown
and reports attribution to GA4. The redirect does not need its own analytics tag.
DNS and HTTPS must route this hostname to the regular control plane; see
[the infrastructure guide](../../infra/README.md).

## References

- [Google campaign parameters](https://support.google.com/analytics/answer/10917952)
- [Cal.com embed events](https://cal.com/help/embedding/embed-events)
- [Cal.com campaign tracking](https://cal.com/help/bookings/utm-tracking)
- [Buttondown native forms and metadata](https://docs.buttondown.com/building-your-subscriber-base)
- [Buttondown redirect settings](https://docs.buttondown.com/api-newsletters-update)
