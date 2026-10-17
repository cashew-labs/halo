import React, { act } from "react";
import { Window } from "../../../tmp/oauth-publishing/test-runtime/node_modules/happy-dom/lib/index.js";
import { IncompatibleServerError } from "@get-halo/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MauiProvider } from "maui";
import { Authentication } from "../src/Authentication.js";
import { HostProvider } from "../src/HostProvider.js";
import type { HostApi } from "../src/HostApi.js";
import { SignInPage } from "../src/SignInPage.js";
import { IntegrationSetupPage } from "../src/IntegrationSetupPage.js";

// Keep routing and disclosure components real; replace design-system browser hooks
// with semantic HTML for this Node-rendered check. Live browser screenshots cover Maui.
vi.mock("maui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("maui")>();
  const container = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    ...actual,
    MauiProvider: container,
    Flex: container,
    Prose: container,
    Button: ({
      children,
      isDisabled,
    }: {
      children: React.ReactNode;
      isDisabled?: boolean;
    }) => <button disabled={isDisabled}>{children}</button>,
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
      <a href={href}>{children}</a>
    ),
    TextField: () => <input />,
    LoadingScreen: ({ progressLabel }: { progressLabel: string }) => (
      <p>{progressLabel}</p>
    ),
  };
});

vi.mock("purse-styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("purse-styles")>()),
  PurseProvider: ({ children }: { children: React.ReactNode }) => children,
  useStyles: () => "",
  useInjectGlobalStyles: () => {},
}));

vi.mock("@get-halo/client", () => ({
  IncompatibleServerError: class extends Error {
    clientProtocolVersion = "1";
    supportedProtocols = [2];
  },
}));

const host: HostApi = {
  showLandingPage: true,
  getAuthSession: () => new Promise(() => {}),
  signIn: async () => undefined,
  signOut: async () => undefined,
  connectHalo: async () => undefined,
  getExtensionFrameUrl: () => "",
  getDesktopFrameUrl: () => "",
  connectIntegration: async () => new Error("No connection"),
  cancelIntegration: async () => undefined,
};

function mockWindow(location: object) {
  vi.stubGlobal("window", { location, matchMedia: () => ({ matches: false }) });
}

beforeEach(() => mockWindow({ pathname: "/", hash: "" }));

function renderGate(path: string, showLandingPage: boolean) {
  mockWindow({ pathname: path });
  return renderToStaticMarkup(
    <MauiProvider>
      <HostProvider host={{ ...host, showLandingPage }}>
        <Authentication>
          <p>Private workspace contents</p>
        </Authentication>
      </HostProvider>
    </MauiProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("public OAuth reviewer access", () => {
  it("exposes product purpose and privacy before authentication responds", () => {
    const html = renderGate("/", true);
    expect(html).toContain('aria-label="Halo home"');
    expect(html).toContain("Connect your Google services");
    expect(html).toContain('href="https://gethalo.dev/privacy.html"');
    expect(html).not.toContain("Private workspace contents");
    expect(html).not.toContain("Loading Halo");
  });

  it.each([
    ["/private", true],
    ["/", false],
  ] as const)(
    "keeps protected path %s and desktop waiting for authentication",
    (path, showLandingPage) => {
      const html = renderGate(path, showLandingPage);
      expect(html).toContain("Loading Halo");
      expect(html).not.toContain("Halo home");
      expect(html).not.toContain("Private workspace contents");
    },
  );

  it("makes privacy available before Google sign-in", () => {
    const html = renderToStaticMarkup(
      <MauiProvider>
        <SignInPage error={undefined} signingIn={false} onSignIn={() => {}} />
      </MauiProvider>,
    );
    expect(html).toContain('href="https://gethalo.dev/privacy.html"');
    expect(html).toContain("Continue with Google");
  });

  it("discloses AI processing and retention before connecting an account", () => {
    mockWindow({ hash: "" });
    const client = new QueryClient();
    const setup = {
      setupId: "oauth-disclosure",
      integration: "google_gmail",
      name: "Gmail",
      connectionName: "Demo",
      status: "awaiting_credentials",
      methods: [
        {
          template: "google",
          label: "Google OAuth",
          kind: "oauth",
          fields: [],
        },
      ],
    };
    client.setQueryData(["integration-setup", setup.setupId], setup);
    const api = {
      read: async () => setup,
      cancel: async () => undefined,
      submit: async () => ({}),
    };
    const html = renderToStaticMarkup(
      <MauiProvider>
        <QueryClientProvider client={client}>
          <IntegrationSetupPage
            setupId={setup.setupId}
            api={api as NonNullable<HostApi["integrationSetup"]>}
          />
        </QueryClientProvider>
      </MauiProvider>,
    );
    expect(html).toContain("Together AI");
    expect(html).toContain("no automatic expiry");
    expect(html).toContain('href="https://gethalo.dev/privacy.html"');
    expect(html).toContain("Connect Gmail");
    client.clear();
  });
});

describe("authentication completes or fails on the public root", () => {
  it.each(["signedOut", "signedIn", "unavailable", "incompatible"])(
    "preserves the %s outcome after session discovery",
    async (outcome) => {
      const browser = new Window({ url: "https://gethalo.dev/" });
      vi.stubGlobal("window", browser);
      vi.stubGlobal("document", browser.document);
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let complete!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => {
        complete = resolve;
      });
      const testHost = { ...host, getAuthSession: () => pending } as HostApi;
      const { createRoot } = await import("react-dom/client");
      const element = browser.document.createElement("div");
      browser.document.body.append(element);
      const root = createRoot(element as unknown as HTMLElement);
      try {
        await act(async () => {
          root.render(
            <MauiProvider>
              <HostProvider host={testHost}>
                <Authentication>
                  <p>Private workspace contents</p>
                </Authentication>
              </HostProvider>
            </MauiProvider>,
          );
        });
        expect(element.textContent).toContain("Connect your Google services");
        expect(element.textContent).not.toContain("Private workspace contents");
        await act(async () => {
          complete(
            outcome === "signedOut"
              ? undefined
              : outcome === "signedIn"
                ? { user: { id: "demo" } }
                : outcome === "incompatible"
                  ? new IncompatibleServerError({} as never)
                  : new Error("Offline"),
          );
          await pending;
        });
        if (outcome === "signedOut") {
          expect(
            element.querySelector('main[aria-label="Halo home"]'),
          ).not.toBeNull();
        } else if (outcome === "signedIn") {
          expect(element.textContent).toContain("Private workspace contents");
          expect(
            element.querySelector('main[aria-label="Halo home"]'),
          ).toBeNull();
        } else {
          expect(
            element.querySelector('main[aria-label="Halo home"]'),
          ).toBeNull();
          expect(element.textContent).not.toContain(
            "Private workspace contents",
          );
          expect(element.textContent).toContain(
            outcome === "incompatible"
              ? "Reload Halo"
              : "Couldn't check your sign-in status",
          );
        }
      } finally {
        await act(async () => root.unmount());
        await browser.happyDOM.close();
      }
    },
  );
});
