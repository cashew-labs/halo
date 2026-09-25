import { Flex, H1, Link, P, Text, radius, shadow, spacing } from "maui";
import { style, useStyles } from "purse-styles";

export function NewsletterStatusPage({
  status,
}: {
  status: "check-email" | "joined";
}) {
  const shell = useStyles(styles.shell);
  const card = useStyles(styles.card);
  const logo = useStyles(styles.logo);

  return (
    <main className={shell} aria-label="Halo newsletter">
      <section className={card}>
        <Flex column gap={12}>
          <Flex row gap={4} alignItems="center">
            <img className={logo} src="/halo-donut-transparent.png" alt="" />
            <Text fontWeight={500} style={{ color: "#eeeeee" }}>
              Halo Newsletter
            </Text>
          </Flex>

          <Flex column gap={4}>
            <Text size="sm" fontWeight={500} style={{ color: "#a8a8a8" }}>
              {status === "check-email" ? "Step 2 of 2" : "Complete"}
            </Text>
            <H1>
              {status === "check-email"
                ? "Check your email"
                : "You're on the list"}
            </H1>
            <P>
              {status === "check-email"
                ? "Click the link we sent you to confirm your subscription."
                : "You'll get the next Halo Dev Log in your inbox."}
            </P>
          </Flex>

          <Link href="/">Back to Halo</Link>
        </Flex>
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
    width: "min(100%, 440px)",
    minWidth: 0,
    backgroundColor: "#191919",
    "& h1": { color: "#eeeeee" },
    "& p": { color: "#b4b4b4" },
    "& a": { color: "#b8a9ff" },
  }),
  logo: style({
    width: 30,
    height: 30,
    objectFit: "contain",
  }),
};
