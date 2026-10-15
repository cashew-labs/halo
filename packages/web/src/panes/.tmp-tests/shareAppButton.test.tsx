// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MauiProvider } from "maui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { AppSummary } from "@get-halo/client";

const api = vi.hoisted(() => ({
  apps: [] as AppSummary[],
  calls: [] as unknown[],
  fail: undefined as string | undefined,
  gate: undefined as Promise<void> | undefined,
  listFail: false,
}));
vi.mock("../../api/ApiProvider.js", () => ({
  useApi: () => ({
    apps: {
      list: async () => { if (api.listFail) throw new Error("Apps are unavailable"); return api.apps; },
      publish: async (input: { extensionId: string; access: { visibility: "public" | "invited"; members: string[] } }) => {
        api.calls.push(["publish", input]);
        await api.gate;
        if (api.fail !== undefined) throw new Error(api.fail);
        const app: AppSummary = { appId: "12345678-1234-1234-1234-123456789abc", extensionId: input.extensionId, displayName: "Books", handle: "michael", slug: input.extensionId, url: `https://michael.gethalo.dev/${input.extensionId}/`, published: true, stage: "live", actions: [], ...input.access };
        api.apps = [app];
        return app;
      },
      update: async (input: { appId: string; access?: { visibility: "public" | "invited"; members: string[] }; published?: boolean }) => {
        api.calls.push(["update", input]);
        const app = { ...api.apps[0]!, ...input.access, published: input.published ?? api.apps[0]!.published };
        api.apps = [app];
        return app;
      },
    },
  }),
}));
// jsdom lacks these browser APIs that Maui and React Aria read.
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const { ShareAppButton } = await import("../ShareAppButton.js");

const roots: (() => void)[] = [];
afterEach(() => { for (const unmount of roots.splice(0)) unmount(); api.apps = []; api.calls = []; api.fail = undefined; api.gate = undefined; api.listFail = false; document.body.innerHTML = ""; });

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(() => act(() => root.unmount()));
  await act(async () => root.render(<MauiProvider><QueryClientProvider client={new QueryClient()}><ShareAppButton extensionId="books" /></QueryClientProvider></MauiProvider>));
  await act(async () => (document.querySelector('[aria-label="Share"]') as HTMLButtonElement).click());
  await settle();
}
async function settle() { for (let index = 0; index < 5; index += 1) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0))); }
const dialog = () => document.querySelector('[role="dialog"]')!;
const button = (name: string) => [...dialog().querySelectorAll("button")].find((element) => element.textContent?.trim() === name || element.getAttribute("aria-label") === name) as HTMLButtonElement | undefined;
const radio = (label: string) => [...dialog().querySelectorAll("label")].find((element) => element.textContent?.includes(label))!.querySelector("input")!;
async function press(name: string) { await act(async () => button(name)!.click()); await settle(); }
async function type(value: string) {
  const input = dialog().querySelector('input[aria-label="Email address to invite"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

test("owners publish to invited people, manage them, and stop sharing", async () => {
  await render();
  expect(dialog().textContent).toContain("Sharing moves this app and its data to its own server");
  await act(async () => radio("Invited Halo users").click());
  await settle();
  // Publishing to nobody is not offered.
  expect(button("Publish")!.disabled).toBe(true);
  await type("not an email");
  expect(button("Invite")!.disabled).toBe(true);
  await type(" Ada@Example.com ");
  await press("Invite");
  await type("grace@example.com");
  await act(async () => (dialog().querySelector("form") as HTMLFormElement).requestSubmit());
  await settle();
  await press("Remove grace@example.com");
  expect(dialog().textContent).toContain("ada@example.com");
  expect(dialog().textContent).not.toContain("grace@example.com");
  await press("Publish");
  expect(api.calls).toEqual([["publish", { extensionId: "books", access: { visibility: "invited", members: ["ada@example.com"] } }]]);
  expect(dialog().querySelector("a")!.getAttribute("href")).toBe("https://michael.gethalo.dev/books/");
  // Editing access offers Save; stopping sharing keeps the app.
  await act(async () => radio("Anyone with the link").click());
  await settle();
  await press("Save");
  await press("Stop sharing");
  expect(api.calls.slice(1)).toEqual([["update", { appId: "12345678-1234-1234-1234-123456789abc", access: { visibility: "public", members: ["ada@example.com"] }, published: undefined }], ["update", { appId: "12345678-1234-1234-1234-123456789abc", access: { visibility: "public", members: ["ada@example.com"] }, published: false }]]);
  expect(dialog().textContent).toContain("Not shared. Only you can open this app.");
  expect(button("Copy link")!.disabled).toBe(true);
  await press("Share again");
  expect(button("Copy link")!.disabled).toBe(false);
});

test("copying the link and failures are reported", async () => {
  api.apps = [{ appId: "12345678-1234-1234-1234-123456789abc", extensionId: "books", displayName: "Books", handle: "michael", slug: "books", url: "https://michael.gethalo.dev/books/", published: true, stage: "live", actions: [], visibility: "public", members: [] }];
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  await render();
  await press("Copy link");
  expect(written).toEqual(["https://michael.gethalo.dev/books/"]);
  expect(button("Copied")).toBeDefined();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  await press("Copied");
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("Could not copy the link");
  await press("Done");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  // Escape dismisses the dialog too.
  await act(async () => (document.querySelector('[aria-label="Share"]') as HTMLButtonElement).click());
  await settle();
  await act(async () => dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("an unfinished or failed publication can be retried", async () => {
  api.apps = [{ appId: "12345678-1234-1234-1234-123456789abc", extensionId: "books", displayName: "Books", handle: "michael", slug: "books", url: "https://michael.gethalo.dev/books/", published: true, stage: "publishing", actions: [], visibility: "public", members: [] }];
  api.fail = "App VM is not reachable";
  await render();
  expect(dialog().textContent).toContain("Publishing is not finished");
  await press("Publish");
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("App VM is not reachable");
  api.fail = undefined;
  await press("Publish");
  expect(button("Stop sharing")).toBeDefined();
});

test("the dialog stays open while publishing and then shows the result", async () => {
  let release = () => {};
  api.gate = new Promise<void>((resolve) => { release = resolve; });
  await render();
  await press("Publish");
  expect(button("Publishing…")!.disabled).toBe(true);
  expect(button("Done")!.disabled).toBe(true);
  await act(async () => dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  api.fail = "This Halo deployment cannot host shared apps";
  await act(async () => release());
  await settle();
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("This Halo deployment cannot host shared apps");
  expect(button("Done")!.disabled).toBe(false);
});

test("a failed app list offers Retry instead of a publish that could overwrite access", { timeout: 20_000 }, async () => {
  api.apps = [{ appId: "12345678-1234-1234-1234-123456789abc", extensionId: "books", displayName: "Books", handle: "michael", slug: "books", url: "https://michael.gethalo.dev/books/", published: false, stage: "live", actions: [], visibility: "invited", members: ["ada@example.com"] }];
  api.listFail = true;
  await render();
  // React Query retries the list before reporting the failure.
  for (let waited = 0; dialog().querySelector('[role="alert"]') === null && waited < 100; waited += 1) await act(async () => await new Promise((resolve) => setTimeout(resolve, 100)));
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("Apps are unavailable");
  expect(button("Publish")).toBeUndefined();
  expect(dialog().textContent).not.toContain("Anyone with the link");
  api.listFail = false;
  await press("Retry");
  expect(button("Publish")).toBeUndefined();
  expect(button("Share again")).toBeDefined();
  expect(api.calls).toEqual([]);
});

test("an invited app cannot be saved or re-shared with nobody invited", async () => {
  api.apps = [{ appId: "12345678-1234-1234-1234-123456789abc", extensionId: "books", displayName: "Books", handle: "michael", slug: "books", url: "https://michael.gethalo.dev/books/", published: false, stage: "live", actions: [], visibility: "invited", members: ["ada@example.com"] }];
  await render();
  expect(button("Share again")!.disabled).toBe(false);
  await press("Remove ada@example.com");
  expect(button("Save")!.disabled).toBe(true);
  expect(button("Share again")!.disabled).toBe(true);
  await act(async () => radio("Anyone with the link").click());
  await settle();
  expect(button("Save")!.disabled).toBe(false);
  expect(api.calls).toEqual([]);
});
