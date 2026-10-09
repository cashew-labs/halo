import { expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IntegrationSetup } from "@get-halo/shared/controlPlaneContract";

const clicks = new Map<string, () => void>();

vi.mock("maui", () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      children,
      onClick,
    }: {
      children?: ReactNode;
      onClick?: () => void;
    }) => {
      if (typeof children === "string" && onClick !== undefined)
        clicks.set(children, onClick);
      return <button>{children}</button>;
    },
    Flex: box,
    H2: box,
    P: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    RadioOption: box,
    RadioOptionGroup: box,
    Text: box,
    TextField: () => <input />,
    proseContainerStyle: {},
  };
});
vi.mock("purse-styles", () => ({ style: () => ({}), useStyles: () => "" }));

globalThis.window = {
  location: { pathname: "/integrations/setup/s1", search: "", hash: "" },
} as unknown as Window & typeof globalThis;

const { IntegrationSetupPage } = await import("../src/IntegrationSetupPage.tsx");

function render(setup: Partial<IntegrationSetup>) {
  const client = new QueryClient();
  client.setQueryData(["integration-setup", "s1"], {
    setupId: "s1",
    integration: "google_gmail",
    name: "Gmail",
    methods: [],
    connectionName: "connection1",
    status: "awaiting_credentials",
    ...setup,
  });
  const api = {
    read: async () => new Error("unused"),
    submit: async () => new Error("unused"),
    cancel: async () => new Error("unused"),
    redeemHandoff: async () => undefined,
    signIn: async () => undefined,
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntegrationSetupPage setupId="s1" api={api} />
    </QueryClientProvider>,
  );
}

test("the setup page names the requested account until the connection is ready", () => {
  expect(render({ account: "me@example.com" })).toContain(
    "Halo asked to connect <strong>me@example.com</strong>",
  );
  expect(render({ account: "me@example.com", status: "ready" })).not.toContain(
    "Halo asked to connect",
  );
  expect(render({})).not.toContain("Halo asked to connect");
});

test("the setup page names the Halo account and explains an unavailable setup", () => {
  expect(render({ owner: "me@example.com" })).toContain(
    "Connecting to the Halo account <strong>me@example.com</strong>",
  );
  expect(render({})).not.toContain("Connecting to the Halo account");
});

async function renderUnavailable(handoff: "none" | "failed") {
  const { SetupUnavailableError } = await import("../src/setupHandoff.ts");
  const client = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  });
  const query = client
    .getQueryCache()
    .build(client, { queryKey: ["integration-setup", "s1"] });
  query.setState({
    status: "error",
    error: new SetupUnavailableError({ handoff }),
    fetchStatus: "idle",
  });
  const signIn = vi.fn(async () => undefined);
  const api = {
    read: async () => new Error("unused"),
    submit: async () => new Error("unused"),
    cancel: async () => new Error("unused"),
    redeemHandoff: async () => undefined,
    signIn,
  };
  clicks.clear();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntegrationSetupPage setupId="s1" api={api} />
    </QueryClientProvider>,
  );
  return { html, signIn };
}

test("an unavailable setup explains a used handoff and offers sign-in", async () => {
  const failed = await renderUnavailable("failed");
  expect(failed.html).toContain(
    "This setup link has expired or was already used.",
  );
  expect(failed.html).toContain("Sign in to Halo");
  clicks.get("Sign in to Halo")!();
  expect(failed.signIn).toHaveBeenCalledTimes(1);
  const unsigned = await renderUnavailable("none");
  expect(unsigned.html).toContain("This connection setup is unavailable.");
  expect(unsigned.html).not.toContain("expired or was already used");
});

test("the page redeems the handoff in its URL before reading the setup", async () => {
  const replaced: string[] = [];
  globalThis.window = {
    location: {
      pathname: "/integrations/setup/s1",
      search: "",
      hash: "#handoff=secret",
    },
    history: {
      state: undefined,
      replaceState: (_state: unknown, _title: string, url: string) =>
        replaced.push(url),
    },
  } as unknown as Window & typeof globalThis;
  const calls: unknown[] = [];
  const api = {
    read: async () => {
      calls.push("read");
      return {
        setupId: "s1",
        integration: "google_gmail",
        name: "Gmail",
        methods: [],
        connectionName: "connection1",
        status: "ready" as const,
      };
    },
    submit: async () => new Error("unused"),
    cancel: async () => new Error("unused"),
    redeemHandoff: async (input: unknown) => {
      calls.push(input);
    },
    signIn: async () => undefined,
  };
  const client = new QueryClient();
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntegrationSetupPage setupId="s1" api={api} />
    </QueryClientProvider>,
  );
  // Run the query function the page registered for its setup.
  await client
    .getQueryCache()
    .find({ queryKey: ["integration-setup", "s1"] })!
    .fetch();
  expect(calls).toEqual([{ setupId: "s1", handoff: "secret" }, "read"]);
  expect(replaced).toEqual(["/integrations/setup/s1"]);
  expect(
    client.getQueryData(["integration-setup", "s1"]),
  ).toMatchObject({ status: "ready" });
});
