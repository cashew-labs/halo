import { createContext, useContext, useState, type ReactNode } from "react";
import type { Key } from "react-aria-components";
import { RouterProvider } from "react-aria-components";
import { NavigationTree } from "react-aria-components/NavigationTree";
import { flex } from "maui";
import { style, useStyles } from "purse-styles";
import { useLocation } from "wouter";

type NavigationSidebarProps = {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
};

const ExpandContext = createContext<(keys: string[]) => void>(() => {});

export function useExpandSidebar() {
  return useContext(ExpandContext);
}

export function NavigationSidebar(props: NavigationSidebarProps) {
  const [location, navigate] = useLocation();
  const [expanded, setExpanded] = useState<Set<Key>>(() => {
    if (!location.startsWith("/files/")) return new Set();
    const segments = decodeURIComponent(location.slice("/files/".length)).split(
      "/",
    );
    return new Set(
      segments
        .slice(0, -1)
        .map(
          (segment, index) =>
            `file:${[...segments.slice(0, index), segment].join("/")}/`,
        ),
    );
  });
  function expand(keys: string[]) {
    setExpanded((current) => new Set([...current, ...keys]));
  }
  const treeClassName = useStyles(tree);

  return (
    <ExpandContext value={expand}>
      <RouterProvider navigate={navigate}>
        <NavigationTree
          aria-label={props["aria-label"]}
          className={joinClassNames(treeClassName, props.className)}
          selectedRoute={canonicalRoute(location)}
          expandedKeys={expanded}
          onExpandedChange={setExpanded}
        >
          {props.children}
        </NavigationTree>
      </RouterProvider>
    </ExpandContext>
  );
}

const tree = style(flex({ direction: "column", gap: 4 }), {
  width: "100%",
  minWidth: 0,
  outline: "none",
});

function canonicalRoute(route: string) {
  return route
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
}

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter((name) => name !== undefined).join(" ");
}
