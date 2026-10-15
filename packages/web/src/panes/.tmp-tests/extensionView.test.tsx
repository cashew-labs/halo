// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MauiProvider } from "maui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { AppSummary } from "@get-halo/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
const state = vi.hoisted(() => ({ apps: [] as AppSummary[], calls: [] as unknown[], cancelFail: undefined as string | undefined, publishFail: undefined as string | undefined, publishGate: undefined as Promise<void> | undefined }));
vi.mock("../../HostProvider.js", () => ({ useHost: () => ({ getExtensionFrameUrl: (id: string) => `/workspace/extensions/${id}/view/` }) }));
vi.mock("../../api/WorkspaceUpdatesProvider.js", () => ({
  useExtensions: () => ({ data: [
    { id: "notes", url: "http://127.0.0.1:1/view/", displayName: "Notes" },
    { id: "books", url: "https://michael.gethalo.dev/books/view/", displayName: "Books", remote: { appId: "12345678-1234-1234-1234-123456789abc" } },
    { id: "reading", url: "", displayName: "Reading list", publishing: { appId: "22345678-1234-1234-1234-123456789abc" } },
  ] }),
}));
vi.mock("../../api/ApiProvider.js", () => ({
  useApi: () => ({ apps: {
    list: async () => state.apps,
    publish: async (input: unknown) => { state.calls.push(["publish", input]); await state.publishGate; if (state.publishFail !== undefined) throw new Error(state.publishFail); return state.apps[0]; },
    cancel: async (input: unknown) => { state.calls.push(["cancel", input]); if (state.cancelFail !== undefined) throw new Error(state.cancelFail); state.apps = []; },
  } }),
}));
const { ExtensionView } = await import("../../main/ExtensionView.js");

const reading: AppSummary = { appId: "22345678-1234-1234-1234-123456789abc", extensionId: "reading", displayName: "reading", handle: "michael", slug: "reading", url: "https://michael.gethalo.dev/reading/", published: true, stage: "publishing", actions: [], visibility: "invited", members: ["ada@example.com"] };
const roots: (() => Promise<void>)[] = [];
afterEach(async () => { for (const unmount of roots.splice(0)) await unmount(); state.apps = []; state.calls = []; state.cancelFail = undefined; state.publishFail = undefined; state.publishGate = undefined; });

async function render(extensionId: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<MauiProvider><QueryClientProvider client={new QueryClient()}><ExtensionView extensionId={extensionId} /></QueryClientProvider></MauiProvider>));
  await settle();
  return container;
}
async function settle() { for (let index = 0; index < 5; index += 1) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0))); }
const button = (container: HTMLElement, name: string) => [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === name);

test("a published app opens from its creator host in the browser; local extensions render in the tab", async () => {
  const books = await render("books");
  const notes = await render("notes");
  expect([...notes.querySelectorAll("iframe")].map((frame) => frame.getAttribute("src"))).toEqual(["/workspace/extensions/notes/view/"]);
  expect(books.querySelector("iframe")).toBeNull();
  const open = books.querySelector("a")!;
  expect([open.textContent, open.getAttribute("href"), open.getAttribute("target")]).toEqual(["Open Books", "https://michael.gethalo.dev/__halo/signin?return=%2Fbooks%2Fview%2F", "_blank"]);
  expect(books.textContent).toContain("Books is shared from its own server.");
});

test("a stalled publish with no recorded failure still offers recovery, and shows an unrecorded error", async () => {
  state.apps = [reading];
  const view = await render("reading");
  expect(view.querySelector("iframe")).toBeNull();
  expect(view.querySelector('[role="status"]')!.textContent).toContain("Publishing Reading list has not finished");
  expect(button(view, "Publish again")).toBeDefined();
  expect(button(view, "Keep it local")).toBeDefined();
  // A failure the control plane did not record (here a lost connection) is still shown.
  state.publishFail = "Failed to fetch";
  await act(async () => button(view, "Publish again")!.click());
  await settle();
  expect(view.querySelector('[role="alert"]')!.textContent).toBe("Failed to fetch");
  expect(button(view, "Publish again")!.disabled).toBe(false);
});

test("an app record that is gone offers no actions", async () => {
  const view = await render("reading");
  expect(button(view, "Publish again")).toBeUndefined();
});

test("a failed publish explains itself in the tab and can be retried with its saved access or kept local", async () => {
  state.apps = [{ ...reading, publishFailure: { message: "Its new server could not start the app.", detail: "App sandbox failed: start", failedAt: Date.UTC(2026, 9, 15, 15, 20) } }];
  const view = await render("reading");
  expect(view.querySelector('[role="alert"]')!.textContent).toContain("Reading list failed to publish.Its new server could not start the app. Your app and its data are safe.");
  expect(view.textContent).not.toContain("App sandbox failed");
  let release = () => {};
  state.publishGate = new Promise<void>((resolve) => { release = resolve; });
  await act(async () => button(view, "Publish again")!.click());
  await settle();
  expect(state.calls).toEqual([["publish", { extensionId: "reading", access: { visibility: "invited", members: ["ada@example.com"] } }]]);
  // While it publishes again, the tab shows progress rather than the old failure.
  expect(view.querySelector('[role="status"]')!.textContent).toContain("is being published");
  await act(async () => release());
  await settle();
  state.cancelFail = "It is already on its own server, so it can't be kept local. Publish again to finish.";
  await act(async () => button(view, "Keep it local")!.click());
  await settle();
  expect(view.textContent).toContain("It is already on its own server, so it can't be kept local. Publish again to finish.");
  state.cancelFail = undefined;
  await act(async () => button(view, "Keep it local")!.click());
  await settle();
  expect(state.calls.at(-1)).toEqual(["cancel", { appId: reading.appId }]);
});
