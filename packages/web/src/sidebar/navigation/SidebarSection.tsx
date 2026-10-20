import { useState, type DragEvent, type ReactNode } from "react";
import {
  NavigationTreeHeader,
  NavigationTreeSection,
  type NavigationTreeHeaderProps,
  type NavigationTreeSectionProps,
} from "react-aria-components/NavigationTree";
import {
  borderColor,
  colors,
  focusRing,
  flex,
  motionDurationMs,
  motionEasing,
  spacing,
  text,
} from "maui";
import { ChevronRight, Dots } from "maui/icons";
import { style, useStyles } from "purse-styles";
import {
  sidebarSectionLabels,
  type SidebarSectionId,
} from "../SidebarPreferences.js";
import {
  useSidebarPreferences,
  useSidebarPreferenceState,
} from "../SidebarPreferencesProvider.js";

const sectionDragType = "application/x-halo-sidebar-section";

export const sidebarPadding = style(spacing.padding({ x: 4 }), {
  "@media (max-width: 700px)": { paddingInline: "16px" },
});

const sidebarSection = style(
  flex({ direction: "column" }),
  spacing.padding({ y: 2 }),
  {
    gap: 1,
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
  },
);

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
  const { collapsedSections, sectionOrder } = useSidebarPreferenceState();
  const collapsed = collapsedSections.includes(props.sectionId);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const name = sidebarSectionLabels[props.sectionId];
  const sectionClassName = useStyles(
    sidebarSection,
    ...(collapsed ? [collapsedSection] : []),
  );
  const labelClassName = useStyles(
    sectionLabel,
    ...(collapsed ? [collapsedLabel] : []),
  );
  const toggleClassName = useStyles(sectionToggle);
  const gripClassName = useStyles(dragHandle);
  const chevronClassName = useStyles(sectionChevron);

  function dragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes(sectionDragType)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setIsDropTarget(true);
  }
  function drop(event: DragEvent) {
    setIsDropTarget(false);
    if (!event.dataTransfer.types.includes(sectionDragType)) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = sectionOrder.find(
      (sectionId) => sectionId === event.dataTransfer.getData(sectionDragType),
    );
    if (sourceId !== undefined)
      preferences.moveSection({ sourceId, targetId: props.sectionId });
  }

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
          data-section-drop={isDropTarget || undefined}
          onClick={() =>
            preferences.setSectionExpanded(props.sectionId, collapsed)
          }
          onDragOver={dragOver}
          onDragLeave={() => setIsDropTarget(false)}
          onDrop={drop}
        >
          <ChevronRight
            size="2xs"
            className={chevronClassName}
            data-expanded={!collapsed || undefined}
          />
          {props.label}
        </button>
        <button
          type="button"
          className={gripClassName}
          aria-label={`Reorder ${name}`}
          title="Drag to reorder, or use the up and down arrow keys."
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(sectionDragType, props.sectionId);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={dragOver}
          onDragLeave={() => setIsDropTarget(false)}
          onDrop={drop}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            event.stopPropagation();
            preferences.shiftSection({
              sectionId: props.sectionId,
              direction: event.key === "ArrowUp" ? -1 : 1,
            });
          }}
        >
          <Dots size="2xs" />
        </button>
        {props.actions}
      </NavigationTreeHeader>
      {!collapsed && props.children}
    </NavigationTreeSection>
  );
}

const sectionLabel = style(
  text({ size: "xs", fontWeight: 500, color: "lowContrast" }),
  sidebarPadding,
  {
    marginBottom: spacing.value(3),
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    "&:hover [draggable], &:focus-within [draggable]": { opacity: 1 },
    minHeight: "28px",
    "@media (max-width: 700px)": {
      minHeight: "36px",
      marginBottom: 0,
    },
  },
);

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
  "&[data-section-drop]": { backgroundColor: colors.accent[4] },
  "@media (max-width: 700px)": { minHeight: "40px" },
});
const collapsedSection = style({ paddingBlock: 0 });
const collapsedLabel = style({ marginBottom: 0 });
const sectionChevron = style({
  flexShrink: 0,
  "&[data-expanded]": { transform: "rotate(90deg)" },
});
const dragHandle = style(focusRing(), {
  display: "grid",
  placeItems: "center",
  width: "24px",
  height: "24px",
  padding: 0,
  border: 0,
  backgroundColor: "transparent",
  color: "inherit",
  cursor: "grab",
  opacity: 0,
  "&:focus-visible": { opacity: 1 },
  "@media (max-width: 700px)": { opacity: 1, width: "40px", height: "40px" },
  "@media (hover: none)": { opacity: 1 },
});

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter((name) => name !== undefined).join(" ");
}
