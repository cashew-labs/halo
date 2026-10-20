import { Button, Flex, LogoIcon, colors, text } from "maui";
import { style, useStyles } from "purse-styles";
import googleLogoUrl from "./assets/google-signin.svg";
import { FullscreenPage } from "./FullscreenPage.js";

export function SignInPage(props: {
  error: string | undefined;
  signingIn: boolean;
  onSignIn: () => void;
}) {
  const error = useStyles(styles.error);
  const privacyLink = useStyles(styles.privacyLink);

  return (
    <FullscreenPage
      label="Sign in to Halo"
      footer={
        <a className={privacyLink} href="https://gethalo.dev/privacy.html">
          Privacy policy
        </a>
      }
    >
      <Flex column gap={4} alignItems="center">
        <Button isDisabled={props.signingIn} onClick={props.onSignIn}>
          <LogoIcon src={googleLogoUrl} />
          {props.signingIn ? "Waiting for Google" : "Continue with Google"}
        </Button>
        {props.error === undefined ? undefined : (
          <div className={error} role="alert">
            {props.error}
          </div>
        )}
      </Flex>
    </FullscreenPage>
  );
}

const styles = {
  // Maui's Link has no size below 14px.
  privacyLink: style(text({ size: "xs", color: "lowContrast" }), {
    textDecoration: "underline",
  }),
  error: style(text({ size: "xs", color: "highContrast" }), {
    color: colors.red[11],
    textAlign: "center",
  }),
};
