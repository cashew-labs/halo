import { expect, test } from "vitest";
import { ConnectionService } from "../src/agent/runtime/ConnectionService.ts";

test("starting a connection adds an account instead of replacing the placeholder name", async () => {
  const inputs: unknown[] = [];
  const connections = new ConnectionService({
    remote: {
      catalog: async () => [],
      startSetup: async (input) => {
        inputs.push(input);
        return { setupId: "setup", setupUrl: "https://halo.example/setup" };
      },
      setup: async () => ({ status: "cancelled" }),
      cancelSetup: async () => undefined,
    },
  });
  for (const request of [
    { kind: "control-plane" as const, integration: "gmail" },
    {
      kind: "control-plane" as const,
      integration: "gmail",
      connectionName: "default",
      newConnection: true,
      account: "me@example.com",
    },
    {
      kind: "control-plane" as const,
      integration: "gmail",
      connectionName: "work",
    },
    // A connection really named "default" can still be reconnected.
    {
      client: "c",
      clientOwner: "user" as const,
      owner: "user" as const,
      connectionName: "default",
      integration: "gmail",
      template: "t",
    },
  ])
    await connections.startConnection({
      sessionId: "s",
      request,
      onEvent: async () => undefined,
    });
  connections.close();
  expect(inputs).toEqual([
    { integration: "gmail", connectionName: undefined },
    {
      integration: "gmail",
      connectionName: undefined,
      account: "me@example.com",
    },
    { integration: "gmail", connectionName: "work" },
    { integration: "gmail", connectionName: "default" },
  ]);
});
