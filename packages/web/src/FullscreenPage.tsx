import type { ReactNode } from "react";
import { backgroundColor, spacing } from "maui";
import { style, useStyles } from "purse-styles";
import haloLogo from "./assets/halo-donut-transparent.png";

export function FullscreenPage({
  children,
  label,
  visual,
}: {
  children: ReactNode;
  label?: string;
  visual?: ReactNode;
}) {
  const shell = useStyles(styles.shell);
  const content = useStyles(styles.content);
  const logo = useStyles(styles.logo);
  return (
    <main className={shell} aria-label={label}>
      <div className={content}>
        {visual ?? <img className={logo} src={haloLogo} alt="Halo" />}
        {children}
      </div>
    </main>
  );
}

const styles = {
  shell: style(spacing.padding({ all: 12 }), {
    display: "grid",
    placeItems: "center",
    minHeight: "var(--halo-window-content-height, 100dvh)",
    backgroundColor: backgroundColor.app,
  }),
  content: style({
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
  logo: style({
    display: "block",
    width: 40,
    height: 40,
    objectFit: "contain",
  }),
};
