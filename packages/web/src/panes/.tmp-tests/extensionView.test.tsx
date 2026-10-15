// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MauiProvider } from "maui";
import { expect, test, vi } from "vitest";

window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
vi.mock("../../HostProvider.js", () => ({ useHost: () => ({ getExtensionFrameUrl: (id: string) => `/workspace/extensions/${id}/view/` }) }));
vi.mock("../../api/WorkspaceUpdatesProvider.js", () => ({
  useExtensions: () => ({ data: [{ id: "notes", url: "http://127.0.0.1:1/view/", displayName: "Notes" }, { id: "books", url: "https://michael.gethalo.dev/books/view/", displayName: "Books", remote: { appId: "12345678-1234-1234-1234-123456789abc" } }] }),
}));
const { ExtensionView } = await import("../../main/ExtensionView.js");

test("a published app opens from its creator host in the browser; local extensions render in the tab", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MauiProvider><ExtensionView extensionId="books" /><ExtensionView extensionId="notes" /></MauiProvider>));
  const frames = [...container.querySelectorAll("iframe")].map((frame) => frame.getAttribute("src"));
  expect(frames).toEqual(["/workspace/extensions/notes/view/"]);
  const open = container.querySelector("a")!;
  expect([open.textContent, open.getAttribute("href"), open.getAttribute("target")]).toEqual(["Open Books", "https://michael.gethalo.dev/books/view/", "_blank"]);
  expect(container.textContent).toContain("Books is shared from its own server.");
  await act(async () => root.unmount());
});
