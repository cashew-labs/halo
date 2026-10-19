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
import { style, useStyles } from "purse-styles";
import { useState } from "react";

const BOOKING_URL = "https://cal.com/team/halo/halo-early-access-chat";

type Step = "choose" | "book" | "waitlist";

export function EarlyAccessDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const [step, setStep] = useState<Step>("choose");
  const booking = useStyles(styles.booking);
  const waitlistForm = useStyles(styles.waitlistForm);
  const waitlistFields = useStyles(styles.waitlistFields);

  const changeOpen = (open: boolean) => {
    if (!open) setStep("choose");
    onOpenChange(open);
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
            <Button variant="quiet" onPress={() => setStep("waitlist")}>
              Join the waitlist instead
            </Button>
            <Button variant="primary" onPress={() => setStep("book")}>
              Book a call
            </Button>
          </DialogActions>
        </>
      )}

      {step === "book" && (
        <>
          <DialogTitle>Book a call</DialogTitle>
          <DialogBody>
            <iframe
              className={booking}
              title="Book a Halo early access call"
              // oxlint-disable-next-line react/iframe-missing-sandbox -- Cal.com is cross-origin and needs storage access.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              src={`${BOOKING_URL}?embed=true&theme=light`}
            />
          </DialogBody>
          <DialogActions>
            <Button variant="quiet" onPress={() => setStep("waitlist")}>
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
        >
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
            <Button variant="quiet" onPress={() => setStep("book")}>
              Book a call instead
            </Button>
            <Button type="submit" variant="primary">
              Join waitlist
            </Button>
          </DialogActions>
        </form>
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
  }),
};
