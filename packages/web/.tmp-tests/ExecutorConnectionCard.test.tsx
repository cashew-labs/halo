import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

const clicks = new Map<string, () => void>();

vi.mock("maui", () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      children,
      isDisabled,
      onClick,
    }: {
      children?: ReactNode;
      isDisabled?: boolean;
      onClick?: () => void;
    }) => {
      if (typeof children === "string" && onClick !== undefined)
        clicks.set(children, onClick);
      return <button disabled={isDisabled}>{children}</button>;
    },
    Flex: box,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    background: { element: {} },
    colors: new Proxy({}, { get: () => ({}) }),
    iconSizeValues: { xl: "24px" },
    radius: { lg: {} },
    shadow: { subtle: {} },
  };
});
vi.mock("maui/icons", () => ({ Check: () => <svg /> }));
vi.mock("purse-styles", () => ({
  style: () => ({}),
  useStyles: () => "",
}));
vi.mock("../src/BrandLogo.tsx", () => ({
  brands: { google: { buttonColor: "blue", buttonForeground: "white" } },
  LogoImage: () => <img />,
}));
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostProvider } from "../src/HostProvider.tsx";
import type { HostApi } from "../src/HostApi.ts";
import { ExecutorConnectionCard } from "../src/main/agent/ExecutorConnectionCard.tsx";
import {
  connectionCardQueryKey,
  connectionStateQueryKey,
  type ConnectionState,
} from "../src/main/agent/ConnectionState.ts";

const request = { kind: "control-plane" as const, integration: "gmail" };
const host = {
  openExternal: () => undefined,
  onExternalLink: () => () => undefined,
} as unknown as HostApi;

function render(
  cardId: string,
  state: ConnectionState | undefined,
  startedCardId: string | undefined,
  sessionId: string | null = "s1",
  options: { client?: QueryClient; host?: HostApi } = {},
) {
  const session = sessionId ?? undefined;
  const client = options.client ?? new QueryClient();
  clicks.clear();
  if (state !== undefined)
    client.setQueryData(connectionStateQueryKey(session, request), state);
  if (startedCardId !== undefined)
    client.setQueryData(connectionCardQueryKey(session, request), {
      cardId: startedCardId,
    });
  const html = renderToStaticMarkup(
    <HostProvider host={options.host ?? host}>
      <QueryClientProvider client={client}>
        <ExecutorConnectionCard
          sessionId={session}
          part={{ kind: "executorConnection", id: cardId, request }}
        />
      </QueryClientProvider>
    </HostProvider>,
  );
  const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(
    (match) => ({
      label: match[1]!.replace(/<[^>]+>/g, ""),
      disabled: /disabled/.test(match[0]),
    }),
  );
  return { html, buttons, client };
}

function click(label: string) {
  const onClick = clicks.get(label);
  if (onClick === undefined) throw new Error(`No ${label} button`);
  onClick();
}

async function settle(client: QueryClient) {
  await vi.waitFor(() => expect(client.isMutating()).toBe(0));
}

describe("ExecutorConnectionCard", () => {
  test("an idle card shows Connect", () => {
    const { buttons } = render("a", undefined, undefined);
    expect(buttons).toEqual([{ label: "Connect", disabled: false }]);
  });

  test("a starting card shows its status without an action", () => {
    const { html, buttons } = render(
      "b",
      { status: "starting", wasConnected: false },
      "a",
    );
    expect(buttons).toEqual([]);
    expect(html).toContain("Starting connection");
  });

  test("every card for an attempt in progress shows Cancel", () => {
    const state: ConnectionState = {
      status: "connecting",
      connectionId: "c1",
      expiresAt: 1,
      wasConnected: false,
    };
    for (const cardId of ["a", "b"]) {
      const { html, buttons } = render(cardId, state, "a");
      expect(html).toContain("Opened in your browser");
      expect(buttons.map((button) => button.label)).toEqual(["Cancel"]);
    }
  });

  test("the starting card shows a connected result with Add account", () => {
    const started = render("a", { status: "connected" }, "a");
    expect(started.html).toContain("Connected");
    expect(started.buttons.map((button) => button.label)).toEqual([
      "Add account",
    ]);
    const other = render("b", { status: "connected" }, "a");
    expect(other.html).not.toContain("Connected");
    expect(other.buttons.map((button) => button.label)).toEqual(["Connect"]);
  });

  test("the starting card shows a failed result with Connect again", () => {
    for (const [status, copy] of [
      ["expired", "Expired"],
      ["failed", "Connection failed"],
      ["cancelled", "Cancelled"],
    ] as const) {
      const started = render("a", { status }, "a");
      expect(started.html).toContain(copy);
      expect(started.buttons.map((button) => button.label)).toEqual([
        "Connect again",
      ]);
      const other = render("b", { status }, "a");
      expect(other.html).not.toContain(copy);
      expect(other.buttons.map((button) => button.label)).toEqual(["Connect"]);
    }
  });

  test("every card shows a result whose starting card is unknown", () => {
    const { html, buttons } = render("b", { status: "expired" }, undefined);
    expect(html).toContain("Expired");
    expect(buttons.map((button) => button.label)).toEqual(["Connect again"]);
  });

  test("actions are disabled without a session", () => {
    expect(render("a", undefined, undefined, null).buttons).toEqual([
      { label: "Connect", disabled: true },
    ]);
    expect(
      render("a", { status: "connected" }, "a", null).buttons,
    ).toEqual([{ label: "Add account", disabled: true }]);
  });

  test("Connect on another card records it as the starting card", async () => {
    const connectIntegration = vi.fn(async () => ({
      status: "authorization-required" as const,
      authorizationUrl: "https://example.test",
      connectionId: "c2",
      expiresAt: 5,
      wasConnected: true,
    }));
    const { client } = render("b", { status: "connected" }, "a", "s1", {
      host: { ...host, connectIntegration } as unknown as HostApi,
    });
    click("Connect");
    await vi.waitFor(() =>
      expect(client.getQueryData(connectionCardQueryKey("s1", request))).toEqual(
        { cardId: "b" },
      ),
    );
    await settle(client);
    expect(connectIntegration).toHaveBeenCalledWith({
      sessionId: "s1",
      request,
    });
    expect(client.getQueryData(connectionStateQueryKey("s1", request))).toEqual({
      status: "connecting",
      connectionId: "c2",
      expiresAt: 5,
      wasConnected: true,
    });
  });

  test("a failed start restores the previous starting card", async () => {
    const connectIntegration = vi.fn(async () => new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const custom = { ...host, connectIntegration } as unknown as HostApi;
    const { client } = render("b", { status: "connected" }, "a", "s1", {
      host: custom,
    });
    click("Connect");
    await settle(client);
    warn.mockRestore();
    expect(client.getQueryData(connectionCardQueryKey("s1", request))).toEqual({
      cardId: "a",
    });
    expect(client.getQueryData(connectionStateQueryKey("s1", request))).toEqual({
      status: "connected",
    });
    expect(
      render("a", undefined, undefined, "s1", { client }).buttons.map(
        (button) => button.label,
      ),
    ).toEqual(["Add account"]);
    expect(
      render("b", undefined, undefined, "s1", { client }).buttons.map(
        (button) => button.label,
      ),
    ).toEqual(["Connect"]);
  });

  test("a connected start marks the card connected", async () => {
    const connectIntegration = vi.fn(async () => ({
      status: "connected" as const,
    }));
    const { client } = render("a", undefined, undefined, "s1", {
      host: { ...host, connectIntegration } as unknown as HostApi,
    });
    click("Connect");
    await settle(client);
    expect(client.getQueryData(connectionStateQueryKey("s1", request))).toEqual({
      status: "connected",
    });
  });

  test("Cancel cancels the attempt in progress", async () => {
    for (const wasConnected of [false, true]) {
      const cancelIntegration = vi.fn(async () => undefined);
      const { client } = render(
        "a",
        { status: "connecting", connectionId: "c1", expiresAt: 1, wasConnected },
        "a",
        "s1",
        { host: { ...host, cancelIntegration } as unknown as HostApi },
      );
      click("Cancel");
      await settle(client);
      expect(cancelIntegration).toHaveBeenCalledWith({
        sessionId: "s1",
        connectionId: "c1",
      });
      expect(
        client.getQueryData(connectionStateQueryKey("s1", request)),
      ).toEqual({ status: wasConnected ? "connected" : "cancelled" });
    }
  });

  test("Add account and Connect again start a new attempt", async () => {
    for (const [status, label] of [
      ["connected", "Add account"],
      ["expired", "Connect again"],
    ] as const) {
      const connectIntegration = vi.fn(async () => ({
        status: "connected" as const,
      }));
      const { client } = render("a", { status }, "a", "s1", {
        host: { ...host, connectIntegration } as unknown as HostApi,
      });
      click(label);
      await settle(client);
      expect(connectIntegration).toHaveBeenCalledTimes(1);
    }
  });
});
