import type { ReactNode } from "react";
import { backgroundColor, spacing } from "maui";
import { style, useStyles } from "purse-styles";
import haloLogo from "./assets/halo-donut-transparent.png";

export function FullscreenPage({
  children,
  footer,
  label,
  visual,
}: {
  children: ReactNode;
  footer?: ReactNode;
  label?: string;
  visual?: ReactNode;
}) {
  const shell = useStyles(styles.shell);
  const content = useStyles(styles.content);
  const footerClass = useStyles(styles.footer);
  const logo = useStyles(styles.logo);
  return (
    <main className={shell} aria-label={label}>
      <div className={content}>
        {visual ?? <img className={logo} src={haloLogo} alt="Halo" />}
        {children}
      </div>
      {footer === undefined ? undefined : (
        <footer className={footerClass}>{footer}</footer>
      )}
    </main>
  );
}

const styles = {
  shell: style(spacing.padding({ all: 12 }), {
    display: "grid",
    // Equal outer rows keep the content centered whether or not a footer is present.
    gridTemplateRows: "1fr auto 1fr",
    justifyItems: "center",
    minHeight: "var(--halo-window-content-height, 100dvh)",
    backgroundColor: backgroundColor.app,
  }),
  content: style({
    gridRow: 2,
    width: "min(100%, 440px)",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    textWrap: "balance",
    gap: spacing.value(12),
    "& section > :not(:first-child)": {
      marginTop: spacing.value(4),
    },
  }),
  footer: style({
    gridRow: 3,
    alignSelf: "end",
  }),
  logo: style({
    display: "block",
    width: 40,
    height: 40,
    objectFit: "contain",
  }),
};
