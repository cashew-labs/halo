import { expect, test } from "vitest";
import type { RemoteConnectionBackend } from "../src/agent/runtime/ConnectionService.ts";
import {
  listConnectionsResult,
  removeConnectionResult,
} from "../src/agent/runtime/connectionTools.ts";

function backend(
  overrides: Partial<RemoteConnectionBackend>,
): RemoteConnectionBackend {
  return {
    catalog: async () => [],
    startSetup: async () => new Error("unused"),
    setup: async () => new Error("unused"),
    cancelSetup: async () => undefined,
    connections: async () => [],
    removeConnection: async () => ({ revocation: "revoked" }),
    ...overrides,
  };
}

const input = { integration: "google_gmail", name: "personal" };

test("listing reports a workspace without control-plane connections", async () => {
  expect(await listConnectionsResult(undefined)).toMatchObject({
    ok: false,
    error: { code: "connections_unavailable" },
  });
});

test("listing reports a control-plane failure", async () => {
  expect(
    await listConnectionsResult(
      backend({ connections: async () => new Error("offline") }),
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "connections_failed", message: "offline" },
  });
});

test("listing returns each connection's integration, name and account", async () => {
  expect(
    await listConnectionsResult(
      backend({
        connections: async () => [
          {
            address: "tools.google_gmail.user.personal",
            integration: "google_gmail",
            name: "personal",
            accountLabel: "me@example.com",
          },
        ],
      }),
    ),
  ).toMatchObject({
    ok: true,
    data: {
      connections: [
        {
          integration: "google_gmail",
          name: "personal",
          account: "me@example.com",
        },
      ],
    },
  });
});

test("removal reports a missing backend and a control-plane failure", async () => {
  expect(await removeConnectionResult(undefined, input)).toMatchObject({
    ok: false,
    error: { code: "connections_unavailable" },
  });
  expect(
    await removeConnectionResult(
      backend({ removeConnection: async () => new Error("not found") }),
      input,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "remove_connection_failed", message: "not found" },
  });
});

test("removal passes the connection and returns the revocation", async () => {
  const calls: unknown[] = [];
  expect(
    await removeConnectionResult(
      backend({
        removeConnection: async (request) => {
          calls.push(request);
          return { revocation: "shared" };
        },
      }),
      input,
    ),
  ).toMatchObject({ ok: true, data: { revocation: "shared" } });
  expect(calls).toEqual([input]);
});
