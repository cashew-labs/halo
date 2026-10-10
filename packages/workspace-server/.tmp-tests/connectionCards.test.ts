import { expect, test } from "vitest";
import type { ConnectionRequest } from "@get-halo/client";
import { addConnectionCard } from "../src/agent/runtime/connectionCards.ts";

test("cards keep released-client fields and mark placeholder names", () => {
  const requests: ConnectionRequest[] = [];
  addConnectionCard(requests, { kind: "control-plane", integration: "gmail" });
  addConnectionCard(requests, {
    kind: "control-plane",
    integration: "gmail",
    connectionName: "work",
  });
  expect(requests).toEqual([
    {
      kind: "control-plane",
      integration: "gmail",
      client: "control-plane",
      clientOwner: "org",
      owner: "user",
      template: "control-plane",
      connectionName: "default",
      newConnection: true,
    },
    {
      kind: "control-plane",
      integration: "gmail",
      client: "control-plane",
      clientOwner: "org",
      owner: "user",
      template: "control-plane",
      connectionName: "work",
      newConnection: false,
    },
  ]);
});

test("repeated cards for the same connection merge", () => {
  const requests: ConnectionRequest[] = [];
  for (let index = 0; index < 2; index++)
    addConnectionCard(requests, { kind: "control-plane", integration: "gmail" });
  expect(requests).toHaveLength(1);
});
