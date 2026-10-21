import {
  backgroundColor,
  Button,
  Flex,
  P,
  Prose,
  proseContainerStyle,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { useEffect, useState } from "react";
import { DevLogs } from "./DevLogs.js";
import { EarlyAccessDialog } from "./EarlyAccessDialog.js";
import {
  trackMarketingEvent,
  trackMarketingPage,
} from "./marketingAnalytics.js";

export function LandingPage({
  analyticsEnabled,
}: {
  analyticsEnabled: boolean;
}) {
  const page = useStyles(styles.page);
  const content = useStyles(styles.content);
  const logo = useStyles(styles.logo);
  const statement = useStyles(styles.statement);
  const footer = useStyles(styles.footer);
  const [earlyAccessOpen, setEarlyAccessOpen] = useState(false);

  useEffect(() => {
    if (analyticsEnabled) trackMarketingPage();
  }, [analyticsEnabled]);

  return (
    <main className={page} aria-label="Halo home">
      <div className={content}>
        <img className={logo} src="/halo-donut-transparent.png" alt="Halo" />

        <Flex column gap={12} alignItems="start">
          <Prose size="md" className={statement}>
            <P>An open-source, self-modifiable, agentic operating system.</P>
          </Prose>
          <Button
            variant="primary"
            onPress={() => {
              trackMarketingEvent("early_access_open");
              setEarlyAccessOpen(true);
            }}
          >
            Get early access
          </Button>
          <EarlyAccessDialog
            isOpen={earlyAccessOpen}
            onOpenChange={setEarlyAccessOpen}
          />
        </Flex>

        <DevLogs />

        <footer className={footer}>
          <a href="https://gethalo.dev/privacy.html">Privacy policy</a>
          {" · "}
          <a href="mailto:team@libretto.sh">Contact Cashew Labs</a>
        </footer>
      </div>
    </main>
  );
}

const styles = {
  page: style({
    minHeight: "100dvh",
    backgroundColor: backgroundColor.app,
  }),
  content: style(proseContainerStyle, {
    width: "100%",
    minHeight: "100dvh",
    marginInline: "auto",
    padding: "clamp(24px, 5vw, 48px)",
    display: "flex",
    flexDirection: "column",
    gap: spacing.value(16),
  }),
  logo: style({
    // The PNG has transparent padding; these dimensions make the visible donut 24px tall.
    width: 30,
    height: 30,
    marginTop: -5,
    marginBottom: -1,
    objectFit: "contain",
  }),
  statement: style({
    "& p": {
      fontWeight: 500,
      textWrap: "pretty",
    },
  }),
  footer: style(text({ size: "xs", fontWeight: 400, color: "lowContrast" }), {
    // Absorbs leftover height so the footer sits at the bottom of the page.
    marginTop: "auto",
    "& a": {
      color: "inherit",
    },
  }),
};
