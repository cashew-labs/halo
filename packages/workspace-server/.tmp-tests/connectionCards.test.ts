import { expect, test } from "vitest";
import type { ConnectionRequest } from "@get-halo/client";
import {
  addConnectionCard,
  connectionCardRequest,
} from "../src/agent/runtime/connectionCards.ts";

test("a card request carries the account only when one is named", () => {
  expect(connectionCardRequest({ integration: "gmail" })).toEqual({
    kind: "control-plane",
    integration: "gmail",
  });
  expect(
    connectionCardRequest({ integration: "gmail", account: "a@example.com" }),
  ).toEqual({
    kind: "control-plane",
    integration: "gmail",
    account: "a@example.com",
  });
});

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

test("cards for the same account merge and cards for other accounts stay", () => {
  const requests: ConnectionRequest[] = [];
  for (const account of [undefined, "a@example.com", "a@example.com", "b@example.com"])
    addConnectionCard(requests, connectionCardRequest({ integration: "gmail", account }));
  addConnectionCard(requests, connectionCardRequest({ integration: "gmail" }));
  expect(
    requests.map((request) => ("account" in request ? request.account : undefined)),
  ).toEqual([undefined, "a@example.com", "b@example.com"]);
});
