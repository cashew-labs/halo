import { useState } from "react";
import {
  backgroundColor,
  Button,
  Flex,
  Link,
  P,
  Prose,
  proseMaxWidth,
  Text,
  TextField,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";

export function LandingPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string>();
  const page = useStyles(styles.page);
  const content = useStyles(styles.content);
  const logo = useStyles(styles.logo);
  const statement = useStyles(styles.statement);
  const field = useStyles(styles.field);
  const feedback = useStyles(styles.feedback);
  const devLogsHeading = useStyles(styles.devLogsHeading);

  return (
    <main className={page} aria-label="Halo home">
      <div className={content}>
        <img className={logo} src="/halo-donut-transparent.png" alt="Halo" />

        <Prose size="md" className={statement}>
          <P>An open-source, self-modifiable, agentic operating system.</P>
        </Prose>

        <form
          aria-label="Newsletter signup"
          onSubmit={(event) => {
            event.preventDefault();
            setMessage("Newsletter signup is not connected yet.");
          }}
        >
          <Flex row gap={4} alignItems="center" style={{ flexWrap: "wrap" }}>
            <div className={field}>
              <TextField
                aria-label="Email address"
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(value) => {
                  setEmail(value);
                  setMessage(undefined);
                }}
                isRequired
              />
            </div>
            <Button type="submit" variant="primary">
              Join newsletter
            </Button>
          </Flex>
          {message && (
            <p className={feedback} role="status">
              {message}
            </p>
          )}
        </form>

        <section aria-labelledby="dev-logs-heading">
          <Flex column gap={6}>
            <h2 id="dev-logs-heading" className={devLogsHeading}>
              Dev Logs
            </h2>
            <P>
              <Text tabular>0001</Text> -{" "}
              <Link href="https://youtu.be/bTsJFEPTkYQ">
                The Personal Computing Revolution Hasn&apos;t Happened Yet.
              </Link>
            </P>
          </Flex>
        </section>
      </div>
    </main>
  );
}

const styles = {
  page: style({
    minHeight: "100dvh",
    backgroundColor: backgroundColor.app,
  }),
  content: style({
    width: "100%",
    maxWidth: proseMaxWidth,
    minHeight: "100dvh",
    marginInline: "auto",
    padding: "clamp(24px, 5vw, 48px)",
    display: "flex",
    flexDirection: "column",
    gap: 80,
  }),
  logo: style({
    // The PNG has transparent padding; these dimensions make the visible donut 28px tall.
    width: 35,
    height: 35,
    marginTop: -6,
    marginBottom: -1,
    objectFit: "contain",
  }),
  statement: style({
    "& p": {
      fontWeight: 500,
      textWrap: "pretty",
    },
  }),
  field: style({
    width: "100%",
    maxWidth: 240,
    minWidth: 0,
  }),
  feedback: style(text({ size: "xs", color: "lowContrast" }), {
    marginTop: 12,
  }),
  devLogsHeading: style(
    text({ size: "md", fontWeight: 500, color: "lowContrast" }),
    { margin: 0 },
  ),
};
