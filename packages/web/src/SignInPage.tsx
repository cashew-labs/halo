import {
  Button,
  Flex,
  H1,
  P,
  backgroundColor,
  colors,
  radius,
  shadow,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { BrandLogo } from "./BrandLogo.tsx";

export function SignInPage(props: {
  error: string | undefined;
  signingIn: boolean;
  onSignIn: () => void;
}) {
  const shell = useStyles(styles.shell);
  const card = useStyles(styles.card);
  const button = useStyles(styles.button);
  const error = useStyles(styles.error);

  return (
    <main className={shell} aria-label="Sign in to Halo">
      <section className={card}>
        <Flex column gap={8}>
          <Flex column gap={3}>
            <H1>Welcome to Halo</H1>
            <P>Sign in to open your workspace.</P>
          </Flex>

          <Flex column gap={4}>
            <Button
              className={button}
              disabled={props.signingIn}
              onClick={props.onSignIn}
            >
              <BrandLogo brand="google" size="md" />
              {props.signingIn ? "Waiting for Google…" : "Continue with Google"}
            </Button>

            {props.error === undefined ? undefined : (
              <div className={error} role="alert">
                {props.error}
              </div>
            )}
          </Flex>
        </Flex>
      </section>
    </main>
  );
}

const styles = {
  shell: style(spacing.padding({ all: 12 }), {
    display: "grid",
    placeItems: "center",
    minHeight: "100vh",
    backgroundColor: colors.gray[2],
  }),
  card: style(shadow.subtle, radius.lg, spacing.padding({ all: 12 }), {
    width: "min(100%, 420px)",
    minWidth: 0,
    backgroundColor: backgroundColor.element,
  }),
  button: style({
    width: "100%",
    height: "36px",
  }),
  error: style(text({ size: "xs", color: "highContrast" }), {
    color: colors.red[11],
  }),
};
