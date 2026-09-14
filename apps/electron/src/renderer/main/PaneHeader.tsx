import type { ReactNode } from "react";
import { Crossfade, border, flex, flexItem, spacing, text } from "maui";
import { style, useStyles } from "purse-styles";

export function PaneHeader({
  section,
  title,
  actions,
}: {
  section?: string;
  title?: string;
  actions?: ReactNode;
}) {
  const header = useStyles(headerClass);
  const titleWrapClassName = useStyles(titleWrapClass);
  const actionsClassName = useStyles(actionsClass);
  const titleClassName = useStyles(titleClass);
  const label = paneLabel(section, title);

  if (label === undefined && actions === undefined) {
    return <header className={header} aria-hidden="true" />;
  }

  return (
    <header className={header} aria-label={label}>
      {label === undefined ? undefined : (
        <Crossfade
          direction="up"
          contentKey={label}
          className={titleWrapClassName}
        >
          <div className={titleClassName}>{label}</div>
        </Crossfade>
      )}
      {actions === undefined ? undefined : (
        <div className={actionsClassName}>{actions}</div>
      )}
    </header>
  );
}

function paneLabel(section: string | undefined, title: string | undefined) {
  if (title === undefined) return section;
  if (section === undefined) return title;
  return `${section} / ${title}`;
}

const headerClass = style(
  flex({ align: "center" }),
  flexItem({ size: "hug" }),
  border(["bottom"], "border"),
  spacing.padding({ x: 12, y: 6 }),
  {
    minWidth: 0,
    minHeight: "36px",
    flexShrink: 0,
    alignSelf: "stretch",
    WebkitAppRegion: "drag",
  },
);

const titleWrapClass = style({
  minWidth: 0,
  flex: "1 1 auto",
});

const titleClass = style(
  text({ size: "sm", fontWeight: 400, color: "lowContrast" }),
  {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
  },
);

const actionsClass = style({
  marginInlineStart: "auto",
  paddingInlineStart: spacing.value(4),
  flexShrink: 0,
  WebkitAppRegion: "no-drag",
});
