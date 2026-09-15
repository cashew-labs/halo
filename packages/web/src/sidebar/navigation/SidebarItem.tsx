import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  Button,
  Link,
  NavigationTreeItem,
  NavigationTreeItemContent,
  type NavigationTreeItemProps,
} from "react-aria-components/NavigationTree";
import {
  backgroundColor,
  colors,
  focusRing,
  motion,
  navigationItem,
  radius,
  spacing,
} from "maui";
import { ChevronRight } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useRoute, useRouter } from "wouter";
import { sidebarPadding } from "./SidebarSection.js";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

type SidebarItemProps = {
  id?: string | number;
  href?: string;
  pageTitle: string;
  children: ReactNode;
  items?: ReactNode;
  hasChildItems?: boolean;
  icon?: IconComponent;
  trailing?: ReactNode;
  className?: string;
  render?: NavigationTreeItemProps["render"];
};

export function SidebarItem(props: SidebarItemProps) {
  const route =
    props.href === undefined ? "/__sidebar-directory__" : props.href;
  const [isActive] = useRoute(route);
  const router = useRouter();
  const itemClassName = useStyles(sidebarItem);
  const linkClassName = useStyles(itemLink);
  const iconWrapClassName = useStyles(
    iconWrap,
    ...(isActive ? [iconWrapActive] : []),
  );
  const iconClassName = useStyles(icon);
  const trailingClassName = useStyles(trailing);
  const chevronClassName = useStyles(chevron);
  const chevronIconClassName = useStyles(chevronIcon);
  const chevronIconExpandedClassName = useStyles(
    chevronIcon,
    chevronIconExpanded,
  );
  const Icon = props.icon;
  const href =
    props.href === undefined
      ? undefined
      : absoluteHref(router.base, props.href);
  return (
    <NavigationTreeItem
      id={props.id}
      href={href}
      hasChildItems={props.hasChildItems}
      textValue={props.pageTitle}
      className={joinClassNames(itemClassName, props.className)}
      render={props.render}
    >
      <NavigationTreeItemContent>
        {({ hasChildItems, isExpanded }) => (
          <>
            {hasChildItems ? (
              <Button slot="chevron" className={chevronClassName}>
                <ChevronRight
                  size="sm"
                  className={
                    isExpanded
                      ? chevronIconExpandedClassName
                      : chevronIconClassName
                  }
                />
              </Button>
            ) : Icon === undefined ? undefined : (
              <span className={iconWrapClassName} aria-hidden="true">
                <Icon className={iconClassName} />
              </span>
            )}
            <Link className={linkClassName}>{props.children}</Link>
            {props.trailing === undefined ? undefined : (
              <span className={trailingClassName}>{props.trailing}</span>
            )}
          </>
        )}
      </NavigationTreeItemContent>
      {props.items}
    </NavigationTreeItem>
  );
}

const sidebarItem = style(navigationItem, sidebarPadding, {
  display: "flex",
  alignItems: "center",
  gap: spacing.value(2),
  minWidth: 0,
  width: "100%",
  borderRadius: 0,
  paddingTop: spacing.value(2),
  paddingBottom: spacing.value(2),
  paddingLeft: `calc(${spacing.value(4)} + (var(--tree-item-level, 1) - 1) * ${spacing.value(4)})`,
  border: 0,
  textDecoration: "none",
  textAlign: "left",
  backgroundColor: "transparent",
  "&[aria-current='page']": {
    backgroundColor: backgroundColor.elementActive,
    color: colors.accent[11],
  },
  "&[data-current]": {
    backgroundColor: backgroundColor.elementActive,
    color: colors.accent[11],
    fontWeight: 500,
  },
});

const itemLink = style({
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "inherit",
  textDecoration: "none",
  outline: "none",
  cursor: "default",
});

const iconWrap = style(radius.sm, {
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
  color: colors.gray[11],
  width: "20px",
  height: "20px",
  marginBlock: "-2px",
  marginLeft: "-2px",
});

const iconWrapActive = style({ color: colors.accent[11] });
const icon = style({ width: "16px", height: "16px" });
const trailing = style({ flexShrink: 0 });

const chevron = style(focusRing(), radius.sm, {
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
  width: "20px",
  height: "20px",
  marginBlock: "-2px",
  marginLeft: "-2px",
  padding: 0,
  border: 0,
  color: colors.gray[11],
  backgroundColor: "transparent",
});

const chevronIcon = style(motion.standard("transform"));
const chevronIconExpanded = style({ transform: "rotate(90deg)" });

function absoluteHref(base: string, href: string) {
  if (href.startsWith("~")) return href.slice(1);
  if (base === "/") return href;
  if (href === "/") return base;
  return `${base}${href}`;
}

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter((name) => name !== undefined).join(" ");
}
