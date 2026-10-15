// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { test, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MauiProvider } from "maui";
import { AccountButton } from "../AccountButton.js";

const service = vi.hoisted(() => ({
  publisher: vi.fn(),
  checkPublisherHandle: vi.fn(),
  renamePublisher: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("../../api/ApiProvider.js", () => ({
  useApi: () => ({ apps: service }),
}));
vi.mock("../../Authentication.js", () => ({
  useAuthenticatedUserId: () => "owner",
  useAccount: () => ({
    session: {
      user: { id: "owner", email: "owner@example.test", name: "Owner" },
    },
    signOut: service.signOut,
  }),
}));
vi.mock("../../ConnectionStatus.js", () => ({
  modalStyle: {},
  overlayStyle: {},
}));

const uiTest = test.extend<{
  ui: {
    text(): string;
    button(name: string): HTMLButtonElement;
    input(value: string): Promise<void>;
    settle(): Promise<void>;
  };
}>({
  ui: async ({ task }, use) => {
    Object.assign(window, {
      matchMedia: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
      scrollTo() {},
    });
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
    service.publisher
      .mockReset()
      .mockResolvedValue({
        handle: "owner",
        origin: "https://owner.gethalo.dev",
      });
    service.checkPublisherHandle
      .mockReset()
      .mockResolvedValue({ available: true });
    service.renamePublisher
      .mockReset()
      .mockImplementation(async ({ handle }) => ({
        handle,
        origin: `https://${handle}.gethalo.dev`,
      }));
    service.signOut.mockReset().mockResolvedValue(undefined);
    const container = document.createElement("div");
    container.dataset.test = task.name;
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    await act(async () =>
      root.render(
        <MauiProvider>
          <QueryClientProvider client={client}>
            <AccountButton />
          </QueryClientProvider>
        </MauiProvider>,
      ),
    );
    const ui = {
      text: () => document.body.textContent ?? "",
      button: (name: string) => {
        const button = Array.from(document.querySelectorAll("button")).find(
          (node) =>
            node.textContent?.trim() === name ||
            node.getAttribute("aria-label") === name,
        );
        if (!button)
          throw new Error(
            `Button ${name} missing: ${document.body.textContent}`,
          );
        return button;
      },
      input: async (value: string) => {
        await act(async () => {
          const input = document.querySelector("input")!;
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )!.set!.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      },
      settle: async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
      },
    };
    await use(ui);
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  },
});

uiTest(
  "account editor checks names, rejects stale results, saves once and refreshes the URL",
  async ({ ui }) => {
    await act(async () => ui.button("Account: owner@example.test").click());
    await ui.settle();
    expect(ui.text()).toContain("https://owner.gethalo.dev");
    expect(ui.button("Save handle").disabled).toBe(true);
    let completeSlow!: (value: { available: boolean; reason: string }) => void;
    service.checkPublisherHandle.mockImplementation(({ handle }) =>
      handle === "slow"
        ? new Promise((resolve) => {
            completeSlow = resolve;
          })
        : Promise.resolve({
            available: handle !== "taken",
            reason: "Already taken",
          }),
    );
    await ui.input("slow");
    expect(ui.text()).toContain("Checking availability");
    await ui.input("taken");
    await ui.settle();
    expect(ui.text()).toContain("Already taken");
    expect(ui.button("Save handle").disabled).toBe(true);
    await ui.input("new-owner");
    await ui.settle();
    await act(async () =>
      completeSlow({ available: false, reason: "Old result" }),
    );
    await ui.settle();
    expect(ui.text()).toContain("Handle available");
    expect(ui.text()).not.toContain("Old result");
    let finish!: (value: { handle: string; origin: string }) => void;
    service.renamePublisher.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(service.renamePublisher).toHaveBeenCalledTimes(1);
    expect(ui.button("Close").disabled).toBe(true);
    await act(async () =>
      finish({ handle: "new-owner", origin: "https://new-owner.gethalo.dev" }),
    );
    await ui.settle();
    expect(ui.text()).toContain("Publishing URL saved");
    expect(ui.text()).toContain("https://new-owner.gethalo.dev");
    expect(ui.button("Save handle").disabled).toBe(true);
    await act(async () => ui.button("Close").click());
  },
);

uiTest(
  "account editor shows load/check/save failures and retries loading",
  async ({ ui }) => {
    service.publisher.mockRejectedValueOnce(new Error("Workspace unavailable"));
    await act(async () => ui.button("Account: owner@example.test").click());
    await ui.settle();
    expect(ui.text()).toContain("Workspace unavailable");
    await act(async () => ui.button("Retry").click());
    await ui.settle();
    service.checkPublisherHandle.mockRejectedValueOnce(new Error("Offline"));
    await ui.input("network");
    await ui.settle();
    expect(ui.text()).toContain("Could not check availability: Offline");
    expect(ui.button("Save handle").disabled).toBe(true);
    await ui.input("available");
    await ui.settle();
    service.renamePublisher.mockRejectedValueOnce(new Error("Race: taken"));
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await ui.settle();
    expect(ui.text()).toContain("Race: taken");
    await act(async () => ui.button("Sign out").click());
  },
);
