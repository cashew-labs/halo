// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MauiProvider } from "maui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import type { AppSummary, ExtensionSummary } from "@get-halo/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const state = vi.hoisted(() => ({ extensions: [] as ExtensionSummary[], apps: [] as AppSummary[], listCalls: 0 }));
vi.mock("../../api/WorkspaceUpdatesProvider.js", () => ({ useExtensions: () => ({ data: state.extensions }) }));
vi.mock("../../database/useDatabaseQuery.js", () => ({ useDatabaseQuery: () => [] }));
vi.mock("../../sidebar/navigation/NavigationSidebar.js", () => ({ useExpandSidebar: () => () => {} }));
vi.mock("../../sidebar/navigation/SidebarSection.js", () => ({ SidebarSection: ({ label, children }: { label: unknown; children: unknown }) => <section>{label as never}{children as never}</section> }));
vi.mock("../../sidebar/navigation/SidebarItem.js", () => ({ SidebarItem: ({ children, trailing }: { children: unknown; trailing?: unknown }) => <div data-item>{children as never}{trailing as never}</div> }));
vi.mock("wouter", () => ({ useLocation: () => ["/"] }));
vi.mock("../../api/ApiProvider.js", () => ({ useApi: () => ({ apps: { list: async () => { state.listCalls += 1; return state.apps; } } }) }));
const { ExtensionsSection } = await import("../../sidebar/ExtensionsSection.js");

async function render() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MauiProvider><QueryClientProvider client={new QueryClient()}><ExtensionsSection /></QueryClientProvider></MauiProvider>));
  for (let index = 0; index < 5; index += 1) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  const items = [...container.querySelectorAll("[data-item]")].map((item) => ({ text: item.textContent, warning: item.querySelector('[aria-label="Publishing failed"]') !== null }));
  await act(async () => root.unmount());
  return items;
}

const app: AppSummary = { appId: "22345678-1234-1234-1234-123456789abc", extensionId: "reading", displayName: "reading", handle: "michael", slug: "reading", url: "https://michael.gethalo.dev/reading/", published: true, stage: "publishing", actions: [], visibility: "public", members: [] };

test("the sidebar keeps a project that is publishing, and marks one whose publish failed", async () => {
  state.extensions = [{ id: "notes", url: "http://127.0.0.1:1/view/", displayName: "Notes" }];
  expect(await render()).toEqual([{ text: "Notes", warning: false }]);
  // Without a publishing project the app list is not fetched.
  expect(state.listCalls).toBe(0);
  state.extensions = [...state.extensions, { id: "reading", url: "", displayName: "Reading list", publishing: { appId: app.appId } }];
  state.apps = [app];
  expect(await render()).toEqual([{ text: "Notes", warning: false }, { text: "Reading listPublishing…", warning: false }]);
  state.apps = [{ ...app, publishFailure: { message: "Its new server could not start the app.", detail: "x", failedAt: 0 } }];
  expect(await render()).toEqual([{ text: "Notes", warning: false }, { text: "Reading list", warning: true }]);
});
