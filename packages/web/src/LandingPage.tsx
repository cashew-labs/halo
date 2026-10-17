import {
  backgroundColor,
  Button,
  Flex,
  Link,
  P,
  Prose,
  proseContainerStyle,
  TextField,
} from "maui";
import { style, useStyles } from "purse-styles";
import { DevLogs } from "./DevLogs.js";

export function LandingPage() {
  const page = useStyles(styles.page);
  const content = useStyles(styles.content);
  const logo = useStyles(styles.logo);
  const statement = useStyles(styles.statement);
  const field = useStyles(styles.field);

  return (
    <main className={page} aria-label="Halo home">
      <div className={content}>
        <img className={logo} src="/halo-donut-transparent.png" alt="Halo" />

        <Prose size="md" className={statement}>
          <P>An open-source, self-modifiable, agentic operating system.</P>
          <P>
            Halo is a desktop workspace for working with AI agents and building
            custom tools. Connect your Google services to work with email,
            calendars, documents, files, and other data through conversations
            and automations. You choose which services to connect and authorize
            their permissions with Google.
          </P>
        </Prose>

        <form
          aria-label="Halo updates signup"
          action="https://buttondown.com/api/emails/embed-subscribe/halo"
          method="post"
        >
          <Flex row gap={4} alignItems="center" style={{ flexWrap: "wrap" }}>
            <div className={field}>
              <TextField
                aria-label="Email address"
                type="email"
                name="email"
                placeholder="Email address"
                validationBehavior="native"
                isRequired
              />
            </div>
            <Button type="submit" variant="primary">
              Get updates
            </Button>
          </Flex>
        </form>

        <DevLogs />

        <Prose size="sm">
          <P>
            <Link href="https://gethalo.dev/privacy.html">Privacy policy</Link>
            {" · "}
            <Link href="mailto:team@libretto.sh">Contact Cashew Labs</Link>
          </P>
        </Prose>
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
    gap: 80,
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
  field: style({
    width: "100%",
    maxWidth: 240,
    minWidth: 0,
  }),
};
