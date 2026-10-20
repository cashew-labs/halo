import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogTitle,
  P,
  radius,
  spacing,
  TextField,
} from "maui";
import * as errore from "errore";
import { style, useStyles } from "purse-styles";
import { useState, type FormEvent } from "react";
import { EarlyAccessBooking } from "./EarlyAccessBooking.js";
import {
  marketingCampaign,
  trackMarketingEvent,
  trackWaitlistAccepted,
  trackWaitlistSubmission,
} from "./marketingAnalytics.js";

class WaitlistSubmissionError extends errore.createTaggedError({
  name: "WaitlistSubmissionError",
  message: "Could not submit the waitlist form in the background.",
}) {}

type Step = "choose" | "book" | "waitlist" | "joined";

export function EarlyAccessDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [joining, setJoining] = useState(false);
  const booking = useStyles(styles.booking);
  const waitlistForm = useStyles(styles.waitlistForm);
  const waitlistFields = useStyles(styles.waitlistFields);

  const chooseStep = (next: "book" | "waitlist") => {
    trackMarketingEvent(next === "book" ? "booking_open" : "waitlist_open");
    setStep(next);
  };

  const changeOpen = (open: boolean) => {
    if (!open) setStep("choose");
    onOpenChange(open);
  };

  const joinWaitlist = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    trackWaitlistSubmission();
    setJoining(true);
    // The response is opaque; a resolved request means Buttondown handled the
    // signup and its redirect stayed within the page's connect-src.
    const sent = await fetch(form.action, {
      method: "POST",
      mode: "no-cors",
      body: new URLSearchParams(
        Array.from(new FormData(form), ([key, value]) => [key, String(value)]),
      ),
    }).catch((cause) => new WaitlistSubmissionError({ cause }));
    setJoining(false);
    if (sent instanceof Error) {
      console.warn(sent);
      // Fall back to the native submission and its check-email return page.
      form.submit();
      return;
    }
    trackWaitlistAccepted();
    setStep("joined");
  };

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={changeOpen}
      size={step === "book" ? "lg" : "sm"}
      isDismissable
    >
      {step === "choose" && (
        <>
          <DialogTitle>Get early access</DialogTitle>
          <DialogBody>
            <P>
              We&apos;re giving a small group free access to Halo. Hop on a
              20-minute call, tell us what you&apos;d use it for, and we&apos;ll
              help you get it done.
            </P>
          </DialogBody>
          <DialogActions>
            <Button variant="quiet" onPress={() => chooseStep("waitlist")}>
              Join the waitlist instead
            </Button>
            <Button variant="primary" onPress={() => chooseStep("book")}>
              Book a call
            </Button>
          </DialogActions>
        </>
      )}

      {step === "book" && (
        <>
          <DialogTitle>Book a call</DialogTitle>
          <DialogBody>
            <EarlyAccessBooking className={booking} />
          </DialogBody>
          <DialogActions>
            <Button variant="quiet" onPress={() => chooseStep("waitlist")}>
              Join the waitlist instead
            </Button>
          </DialogActions>
        </>
      )}

      {step === "waitlist" && (
        <form
          aria-label="Halo waitlist signup"
          action="https://buttondown.com/api/emails/embed-subscribe/halo"
          method="post"
          className={waitlistForm}
          onSubmit={(event) => void joinWaitlist(event)}
        >
          {Object.entries(marketingCampaign()).map(([key, value]) => (
            <input
              key={key}
              type="hidden"
              name={`metadata__${key}`}
              value={value}
            />
          ))}
          <DialogTitle>Join the waitlist</DialogTitle>
          <div className={waitlistFields}>
            <P>We&apos;ll email you when Halo is ready for you.</P>
            <TextField
              aria-label="Email address"
              type="email"
              name="email"
              placeholder="Email address"
              validationBehavior="native"
              isRequired
              autoFocus
            />
          </div>
          <DialogActions>
            <Button variant="quiet" onPress={() => chooseStep("book")}>
              Book a call instead
            </Button>
            <Button type="submit" variant="primary" isDisabled={joining}>
              Join waitlist
            </Button>
          </DialogActions>
        </form>
      )}

      {step === "joined" && (
        <>
          <DialogTitle>You&apos;re on the waitlist</DialogTitle>
          <DialogBody>
            <P>Check your email to confirm your spot.</P>
          </DialogBody>
          <DialogActions>
            <Button variant="primary" onPress={() => changeOpen(false)}>
              Done
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

const styles = {
  // Lets the title, fields, and actions use the dialog's own spacing.
  waitlistForm: style({ display: "contents" }),
  waitlistFields: style({
    display: "flex",
    flexDirection: "column",
    gap: spacing.value(4),
  }),
  booking: style(radius.md, {
    display: "block",
    width: "100%",
    height: "min(500px, calc(100dvh - 200px))",
    border: 0,
    overflow: "auto",
  }),
};
