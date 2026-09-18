import { monoFontStyle } from "maui";
import { style, useStyles } from "purse-styles";
import haloDonutUrl from "./assets/halo-donut-pixel.gif";

export function MarketingPage() {
  const shell = useStyles(styles.shell);
  const landing = useStyles(styles.landing);
  const donutFrame = useStyles(styles.donutFrame);
  const donut = useStyles(styles.donut);
  const heading = useStyles(styles.heading);

  return (
    <main className={shell} aria-label="Halo">
      <section className={landing}>
        <div className={donutFrame} aria-hidden="true">
          <img className={donut} src={haloDonutUrl} alt="" />
        </div>

        <h1 className={heading}>
          THE COMPUTING REVOLUTION HASN&apos;T HAPPENED YET
        </h1>
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
};
