import { colors, monoFontStyle } from "maui";
import { style, useStyles } from "purse-styles";
import haloDonutUrl from "./assets/halo-donut-pixel.gif";

export function SignInPage(props: {
  error: string | undefined;
  signingIn: boolean;
  onSignIn: () => void;
}) {
  const shell = useStyles(styles.shell);
  const landing = useStyles(styles.landing);
  const donutFrame = useStyles(styles.donutFrame);
  const donut = useStyles(styles.donut);
  const heading = useStyles(styles.heading);
  const signup = useStyles(styles.signup);
  const email = useStyles(styles.email);
  const signUp = useStyles(styles.signUp);
  const error = useStyles(styles.error);

  return (
    <main className={shell} aria-label="Sign in to Halo">
      <section className={landing}>
        <div className={donutFrame} aria-hidden="true">
          <img className={donut} src={haloDonutUrl} alt="" />
        </div>

        <h1 className={heading}>
          THE COMPUTING REVOLUTION HASN&apos;T HAPPENED YET
        </h1>

        <form
          className={signup}
          onSubmit={(event) => {
            event.preventDefault();
            props.onSignIn();
          }}
        >
          <input
            className={email}
            type="email"
            aria-label="Email address"
            placeholder="EMAIL"
            disabled={props.signingIn}
          />
          <button
            className={signUp}
            type="submit"
            aria-label="Continue with Google"
            disabled={props.signingIn}
          >
            {props.signingIn ? "WAITING…" : "SIGN UP"}
          </button>
        </form>

        {props.error === undefined ? undefined : (
          <p className={error} role="alert">
            {props.error}
          </p>
        )}
      </section>
    </main>
  );
}

const styles = {
  shell: style({
    minHeight: "100dvh",
    backgroundColor: "#F8FAF8",
    color: "#1D211C",
  }),
  landing: style({
    position: "absolute",
    top: "32px",
    left: "32px",
    width: "calc(100% - 64px)",
  }),
  donutFrame: style({
    width: "22px",
    height: "22px",
    overflow: "hidden",
  }),
  donut: style({
    display: "block",
    width: "32px",
    height: "32px",
    maxWidth: "none",
    transform: "translate(-6px, -6px)",
    imageRendering: "pixelated",
  }),
  heading: style(monoFontStyle, {
    margin: "64px 0 0",
    maxWidth: "100%",
    fontSize: "16px",
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: "0.02em",
  }),
  signup: style({
    display: "flex",
    width: "min(380px, 100%)",
    marginTop: "64px",
  }),
  email: style(monoFontStyle, {
    appearance: "none",
    minWidth: 0,
    flex: 1,
    margin: 0,
    border: "1px solid #1D211C",
    borderRight: 0,
    borderRadius: 0,
    padding: "1px",
    backgroundColor: "#F8FAF8",
    color: "#1D211C",
    fontSize: "16px",
    lineHeight: 1,
    outlineOffset: "2px",
  }),
  signUp: style(monoFontStyle, {
    appearance: "none",
    margin: 0,
    border: "1px solid #1D211C",
    borderRadius: 0,
    padding: "1px 16px",
    backgroundColor: "#1D211C",
    color: "#F8FAF8",
    fontSize: "16px",
    lineHeight: 1,
    cursor: "pointer",
    outlineOffset: "2px",
    "&:hover:not(:disabled)": {
      backgroundColor: "#353B33",
    },
    "&:disabled": {
      cursor: "default",
      opacity: 0.6,
    },
  }),
  error: style(monoFontStyle, {
    margin: "16px 0 0",
    color: colors.red[11],
    fontSize: "14px",
    lineHeight: 1.2,
  }),
};
