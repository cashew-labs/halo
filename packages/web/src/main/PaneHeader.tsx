import { Menu, Plus } from "maui/icons";
import { useSidebar } from "../WorkspaceLayout.js";
import {
  Button,
  Crossfade,
  Tooltip,
  border,
  flex,
  flexItem,
  spacing,
  text,
} from "maui";
import { useLocation } from "wouter";
import { style, useStyles } from "purse-styles";

export function PaneHeader({
  section,
  title,
}: {
  section?: string;
  title?: string;
}) {
  const sidebar = useSidebar();
  const [, navigate] = useLocation();
  const headerButton = useStyles(headerButtonClass);
  const header = useStyles(headerClass);
  const titleWrapClassName = useStyles(titleWrapClass);
  const titleClassName = useStyles(titleClass);
  const label = paneLabel(section, title);

  return (
    <header className={header} aria-label={label}>
      {sidebar.isMobile && (
        <Button
          variant="quiet"
          aria-label="Open sidebar"
          aria-haspopup="dialog"
          className={headerButton}
          onClick={sidebar.open}
        >
          <Menu size="md" />
        </Button>
      )}
      <Crossfade
        direction="up"
        contentKey={label === undefined ? "New session" : label}
        className={titleWrapClassName}
      >
        <div className={titleClassName}>
          {label === undefined ? "New session" : label}
        </div>
      </Crossfade>
      <Tooltip content="New session">
        <Button
          variant="quiet"
          aria-label="New session"
          className={headerButton}
          onClick={() => navigate(`/draft/${crypto.randomUUID()}`)}
        >
          <Plus size="md" aria-hidden="true" />
        </Button>
      </Tooltip>
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
    minHeight: "44px",
    paddingBlock: "6px",
    flexShrink: 0,
    alignSelf: "stretch",
    WebkitAppRegion: "drag",
    "@media (max-width: 700px)": {
      minHeight: "56px",
      padding: "6px 12px",
      gap: "8px",
      paddingTop: "max(6px, env(safe-area-inset-top))",
    },
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

const headerButtonClass = style({
  minWidth: "28px",
  minHeight: "28px",
  "@media (max-width: 700px)": {
    minWidth: "44px",
    minHeight: "44px",
  },
  flexShrink: 0,
  WebkitAppRegion: "no-drag",
});
