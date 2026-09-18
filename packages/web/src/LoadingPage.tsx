import { useEffect, useState } from "react";
import { Thinking } from "maui";
import { style, useStyles } from "purse-styles";

const SHOW_INDICATOR_AFTER_MS = 2000;

export function LoadingPage() {
  const [showIndicator, setShowIndicator] = useState(false);
  const shell = useStyles(styles.shell);
  const indicator = useStyles(
    styles.indicator,
    { transition: "opacity ease-out 0.8s" },
    showIndicator ? styles.indicatorVisible : undefined,
  );

  useEffect(() => {
    const timeout = setTimeout(() => {
      setShowIndicator(true);
    }, SHOW_INDICATOR_AFTER_MS);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <main className={shell}>
      <div className={indicator}>
        <Thinking size="0.8rem" variant="accent" />
      </div>
    </main>
  );
}

const styles = {
  shell: style({
    display: "grid",
    placeItems: "center",
    height: "100vh",
  }),
  indicator: style({
    opacity: 0,
  }),
  indicatorVisible: style({
    opacity: 1,
  }),
};
