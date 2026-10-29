import { type ReactNode } from "react";
import {
  NavigationTreeHeader,
  NavigationTreeSection,
  type NavigationTreeHeaderProps,
  type NavigationTreeSectionProps,
} from "react-aria-components/NavigationTree";
import {
  borderColor,
  focusRing,
  flex,
  motionDurationMs,
  motionEasing,
  spacing,
  text,
} from "maui";
import { ChevronRight } from "maui/icons";
import { style, useStyles } from "purse-styles";
import {
  sidebarSectionLabels,
  type SidebarSectionId,
} from "../SidebarPreferences.js";
import {
  useSidebarPreferences,
  useSidebarPreferenceState,
} from "../SidebarPreferencesProvider.js";

export const sidebarPadding = style(spacing.padding({ x: 4 }), {
  "@media (max-width: 700px)": { paddingInline: "16px" },
});

const sidebarSection = style(flex({ direction: "column" }), {
  gap: 0,
  minWidth: 0,
  width: "100%",
  borderTop: "1px solid transparent",
  borderBottom: "1px solid transparent",
  transition: `border-color ${motionDurationMs}ms ${motionEasing}`,
  "@media (max-width: 700px)": {
    paddingBlock: 0,
    border: 0,
  },
  "&:hover": {
    borderTopColor: borderColor.outline,
    borderBottomColor: borderColor.outline,
  },
});

type SidebarSectionProps = {
  sectionId: SidebarSectionId;
  label: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
  renderHeader?: NavigationTreeHeaderProps["render"];
  render?: NavigationTreeSectionProps<object>["render"];
};

export function SidebarSection(props: SidebarSectionProps) {
  const preferences = useSidebarPreferences();
  const { collapsedSections } = useSidebarPreferenceState();
  const collapsed = collapsedSections.includes(props.sectionId);
  const name = sidebarSectionLabels[props.sectionId];
  const sectionClassName = useStyles(sidebarSection);
  const labelClassName = useStyles(sectionLabel);
  const toggleClassName = useStyles(sectionToggle);
  const chevronClassName = useStyles(sectionChevron, sectionControl);
  const actionsClassName = useStyles(sectionControl);

  return (
    <NavigationTreeSection
      id={`section:${props.sectionId}`}
      className={joinClassNames(sectionClassName, props.className)}
      render={(sectionProps, state) => {
        // React Aria otherwise names the group after every control in its header.
        const labeledProps = {
          ...sectionProps,
          "aria-label": name,
          "aria-labelledby": undefined,
        };
        return props.render === undefined ? (
          <div {...labeledProps} />
        ) : (
          props.render(labeledProps, state)
        );
      }}
    >
      <NavigationTreeHeader
        aria-label={name}
        className={joinClassNames(labelClassName, props.headerClassName)}
        render={props.renderHeader}
      >
        <button
          type="button"
          className={toggleClassName}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
          aria-expanded={!collapsed}
          onClick={() =>
            preferences.setSectionExpanded(props.sectionId, collapsed)
          }
        >
          {props.label}
          <ChevronRight
            size="2xs"
            className={chevronClassName}
            data-section-control
            data-expanded={!collapsed || undefined}
          />
        </button>
        {props.actions !== undefined && (
          <span
            className={actionsClassName}
            data-section-control
            data-section-actions
          >
            {props.actions}
          </span>
        )}
      </NavigationTreeHeader>
      {!collapsed && props.children}
    </NavigationTreeSection>
  );
}

const sectionLabel = style(
  text({ size: "xs", fontWeight: 500, color: "lowContrast" }),
  sidebarPadding,
  {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    "&:hover [data-section-control], &:has(:focus-visible) [data-section-control], & [data-section-control]:has([aria-expanded='true'])":
      {
        opacity: 1,
        pointerEvents: "auto",
      },
    "& [data-section-actions]": {
      display: "flex",
      alignItems: "center",
      flexShrink: 0,
    },
    minHeight: "28px",
    "@media (max-width: 700px)": {
      minHeight: "40px",
    },
  },
);

const sectionControl = style({
  opacity: 0,
  pointerEvents: "none",
  "@media (max-width: 700px)": { opacity: 1, pointerEvents: "auto" },
  "@media (hover: none)": { opacity: 1, pointerEvents: "auto" },
});

const sectionToggle = style(focusRing(), {
  display: "flex",
  alignItems: "center",
  minHeight: "28px",
  flex: "1 1 auto",
  minWidth: 0,
  justifyContent: "start",
  gap: spacing.value(2),
  padding: 0,
  border: 0,
  backgroundColor: "transparent",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  "@media (max-width: 700px)": { minHeight: "40px" },
});
const sectionChevron = style({
  flexShrink: 0,
  "&[data-expanded]": { transform: "rotate(90deg)" },
});
function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter((name) => name !== undefined).join(" ");
}
