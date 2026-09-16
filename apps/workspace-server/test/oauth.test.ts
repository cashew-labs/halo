import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Logger } from "@get-halo/logger";
import type {
  ConnectionRequest,
  OAuthCompletion,
  HaloConnectionEvent,
} from "@get-halo/client";
import { expect, test } from "vitest";
import { ConnectionService } from "../src/agent/runtime/ConnectionService.js";
import { handleOAuthCallback } from "../src/server/oauth.js";

const request: ConnectionRequest = {
  client: "test-client",
  clientOwner: "org",
  owner: "user",
  connectionName: "default",
  integration: "test-integration",
  template: "oauth2",
};

class FakeOAuthRuntime {
  readonly state = "test-oauth-state";
  completionKind: OAuthCompletion["kind"] | undefined;
  redirectUri: string | undefined;

  async startOAuth(input: ConnectionRequest & { completion: OAuthCompletion }) {
    this.completionKind = input.completion.kind;
    this.redirectUri = input.completion.redirectUri;
    return {
      status: "redirect" as const,
      authorizationUrl: `https://provider.example/authorize?state=${this.state}`,
      state: this.state,
    };
  }

  async completeOAuth(_input: { state: string; code: string }) {
    return undefined;
  }

  async cancelOAuth(_state: string) {
    return undefined;
  }
}

test("server OAuth completion redirects to its pending session", async () => {
  await using setup = await createOAuthTest();
  const started = await setup.start("server-redirect");
  if (started instanceof Error) throw started;

  const response = await fetch(
    `${setup.origin}/oauth/callback?state=${setup.runtime.state}&code=accepted`,
    { redirect: "manual" },
  );

  expect(setup.runtime.redirectUri).toBe(
    "https://halo.example/workspace/oauth/callback",
  );
  expect(setup.runtime.completionKind).toBe("server-redirect");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/#/sessions/session%2Fone");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(setup.connections.statesForSession("session/one")).toMatchObject([
    { request, status: "connected" },
  ]);
});

test("server OAuth cancellation redirects with cancelled state", async () => {
  await using setup = await createOAuthTest();
  const started = await setup.start("server-redirect");
  if (started instanceof Error) throw started;

  const response = await fetch(
    `${setup.origin}/oauth/callback?state=${setup.runtime.state}&error=access_denied`,
    { redirect: "manual" },
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/#/sessions/session%2Fone");
  expect(setup.connections.statesForSession("session/one")).toMatchObject([
    { request, status: "cancelled" },
  ]);
});

test("OAuth callback rejects state that is not pending", async () => {
  await using setup = await createOAuthTest();

  const response = await fetch(
    `${setup.origin}/oauth/callback?state=unknown&code=accepted`,
    { redirect: "manual" },
  );

  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
  expect(await response.text()).toBe("Authorization is no longer pending.");
});

test("client loopback completion keeps the close-tab response", async () => {
  await using setup = await createOAuthTest();
  const started = await setup.start("client-loopback");
  if (started instanceof Error) throw started;

  const response = await fetch(
    `${setup.origin}/oauth/callback?state=${setup.runtime.state}&code=accepted`,
    { redirect: "manual" },
  );

  expect(response.status).toBe(200);
  expect(setup.runtime.completionKind).toBe("client-loopback");
  expect(response.headers.get("location")).toBeNull();
  expect(await response.text()).toContain("You can close this tab.");
});

async function createOAuthTest() {
  const runtime = new FakeOAuthRuntime();
  const connections = new ConnectionService(runtime);
  const logger = new Logger({ sinks: [] });
  const server = createServer(async (incoming, response) => {
    await handleOAuthCallback({
      url: new URL(
        incoming.url === undefined ? "/" : incoming.url,
        origin(server),
      ),
      request: incoming,
      response,
      context: { connections, logger },
    });
  });
  server.listen(0, "127.0.0.1");
  const listening = await once(server, "listening").catch(
    (cause) =>
      new Error("Could not start the OAuth callback test server", { cause }),
  );
  if (listening instanceof Error) throw listening;
  return {
    connections,
    origin: origin(server),
    runtime,
    async start(kind: "client-loopback" | "server-redirect") {
      const events: HaloConnectionEvent[] = [];
      const started = await connections.startConnection({
        sessionId: "session/one",
        request,
        completion: {
          kind,
          redirectUri: "https://halo.example/workspace/oauth/callback",
        },
        onEvent: async (event) => {
          events.push(event);
          return undefined;
        },
      });
      if (!(started instanceof Error)) {
        expect(events).toMatchObject([{ status: "connecting" }]);
      }
      return started;
    },
    async [Symbol.asyncDispose]() {
      connections.close();
      logger.destroy();
      server.closeAllConnections();
      const closed = await new Promise<Error | undefined>((resolve) =>
        server.close((error) => resolve(error)),
      );
      if (closed instanceof Error) throw closed;
    },
  };
}

function origin(server: Server) {
  // SAFETY: createOAuthTest calls this only after the TCP server starts listening.
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
