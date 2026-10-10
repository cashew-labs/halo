import { expect, test, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { HostApi } from "../src/HostApi.ts";

const rendered: ReactElement[] = [];
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: (tree: ReactElement) => rendered.push(tree) }),
}));
vi.mock("maui", () => ({
  MauiProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../src/HaloAppRoutes.tsx", () => ({
  HaloAppRoutes: () => null,
}));

const { mountHaloApp } = await import("../src/mountHaloApp.tsx");
const { HaloAppRoutes } = await import("../src/HaloAppRoutes.tsx");

function find(node: ReactNode, type: unknown): ReactElement | undefined {
  if (node === null || typeof node !== "object" || !("props" in node))
    return undefined;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === type) return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = find(child, type);
    if (found !== undefined) return found;
  }
  return undefined;
}

test("the app mounts the route tree with its host", () => {
  const host = {} as HostApi;
  mountHaloApp({} as HTMLElement, host);
  const routes = find(rendered[0], HaloAppRoutes);
  expect(routes?.props).toEqual({ host });
});
