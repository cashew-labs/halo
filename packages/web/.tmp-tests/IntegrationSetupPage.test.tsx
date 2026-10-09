import { expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IntegrationSetup } from "@get-halo/shared/controlPlaneContract";

vi.mock("maui", () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: box,
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
