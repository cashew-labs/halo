import {
  backgroundColor,
  Button,
  Flex,
  P,
  Prose,
  proseMaxWidth,
  TextField,
} from "maui";
import { style, useStyles } from "purse-styles";
import { DevLogs } from "./DevLogs";

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
