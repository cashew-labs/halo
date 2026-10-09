import { expect, test } from "vitest";
import { connectionRequestKey } from "../src/ConnectionRequest.ts";

test("requests without an account keep their existing key", () => {
  expect(
    connectionRequestKey({ kind: "control-plane", integration: "gmail" }),
  ).toBe(JSON.stringify(["gmail", "default"]));
  expect(
    connectionRequestKey({
      client: "c",
      clientOwner: "user",
      owner: "user",
      connectionName: "work",
      integration: "gmail",
      template: "t",
    }),
  ).toBe(JSON.stringify(["gmail", "work"]));
});

test("requests for different accounts have different keys", () => {
  const a = connectionRequestKey({
    kind: "control-plane",
    integration: "gmail",
    account: "a@example.com",
  });
  const b = connectionRequestKey({
    kind: "control-plane",
    integration: "gmail",
    account: "b@example.com",
  });
  expect(a).toBe(JSON.stringify(["gmail", "default", "a@example.com"]));
  expect(a).not.toBe(b);
});
