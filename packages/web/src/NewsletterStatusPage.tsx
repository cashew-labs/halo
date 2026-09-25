import { backgroundColor, P, radius, shadow, spacing, text } from "maui";
import { style, useStyles } from "purse-styles";
import { DevLogs } from "./DevLogs.js";

export function NewsletterStatusPage({
  status,
}: {
  status: "check-email" | "joined";
}) {
  const shell = useStyles(styles.shell);
  const card = useStyles(styles.card);
  const logo = useStyles(styles.logo);
  const logoLink = useStyles(styles.logoLink);
  const message = useStyles(styles.message);
  const heading = useStyles(styles.heading);

  return (
    <main className={shell} aria-label="Halo updates">
      <section className={card}>
        <div className={logoLink}>
          <a href="/" aria-label="Halo home">
            <img className={logo} src="/halo-donut-transparent.png" alt="" />
          </a>
        </div>

        <div className={message}>
          <h1 className={heading}>
            {status === "check-email"
              ? "Check your email to confirm your subscription."
              : "You're on the list."}
          </h1>
          {status === "joined" && (
            <P>Here are some videos to help you learn more about Halo.</P>
          )}
        </div>

        {status === "joined" && <DevLogs showHeading={false} />}
      </section>
    </main>
  );
}

const styles = {
  shell: style(spacing.padding({ all: 12 }), {
    display: "grid",
    placeItems: "center",
    minHeight: "100dvh",
    backgroundColor: backgroundColor.app,
  }),
  card: style(shadow.subtle, radius.lg, spacing.padding({ all: 12 }), {
    width: "min(100%, 520px)",
    minWidth: 0,
    backgroundColor: backgroundColor.element,
    display: "flex",
    flexDirection: "column",
    gap: 32,
  }),
  logo: style({
    width: 30,
    height: 30,
    marginTop: -5,
    marginBottom: -1,
    objectFit: "contain",
  }),
  logoLink: style({ width: "fit-content" }),
  message: style(text({ size: "md", fontWeight: 400, color: "lowContrast" }), {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    "& p": {
      color: "inherit",
      fontSize: "inherit",
      fontWeight: 400,
      margin: 0,
      textWrap: "pretty",
    },
  }),
  heading: style(text({ size: "md", fontWeight: 500, color: "highContrast" }), {
    margin: 0,
    textWrap: "pretty",
  }),
};
