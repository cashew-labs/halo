import { Link, P, Prose, radius, shadow, spacing } from "maui";
import { style, useStyles } from "purse-styles";

export function NewsletterStatusPage({
  status,
}: {
  status: "check-email" | "joined";
}) {
  const shell = useStyles(styles.shell);
  const card = useStyles(styles.card);
  const logo = useStyles(styles.logo);
  const statement = useStyles(styles.statement);

  return (
    <main className={shell} aria-label="Halo newsletter">
      <section className={card}>
        <img className={logo} src="/halo-donut-transparent.png" alt="Halo" />

        <Prose size="md" className={statement}>
          <P>
            {status === "check-email"
              ? "Check your email to confirm your subscription."
              : "You're on the list."}
          </P>
        </Prose>

        <Link href="/">Back to Halo</Link>
      </section>
    </main>
  );
}

const styles = {
  shell: style(spacing.padding({ all: 12 }), {
    display: "grid",
    placeItems: "center",
    minHeight: "100dvh",
    backgroundColor: "#111111",
  }),
  card: style(shadow.subtle, radius.lg, spacing.padding({ all: 12 }), {
    width: "min(100%, 520px)",
    minWidth: 0,
    backgroundColor: "#191919",
    display: "flex",
    flexDirection: "column",
    gap: 80,
  }),
  logo: style({
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
};
