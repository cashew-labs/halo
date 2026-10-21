import events from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test } from "vitest";
import {
  googleDiscoveryAdapter,
  scopedGoogleDiscoveryAdapter,
} from "../integrations/googleDiscoveryAdapter.js";

const discoveryTest = test.extend<{
  provider: {
    url: string;
    requests: string[];
    response: { status: number; body: string; disconnect: boolean };
  };
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  provider: async ({}, use) => {
    const requests: string[] = [];
    const response = { status: 200, body: "", disconnect: false };
    const server = http.createServer((request, outgoing) => {
      requests.push(request.url!);
      if (response.disconnect) request.socket.destroy();
      else
        outgoing
          .writeHead(response.status, { "content-type": "application/json" })
          .end(response.body);
    });
    server.listen(0, "127.0.0.1");
    await events.once(server, "listening");
    // SAFETY: The numeric TCP listener has started.
    const address = server.address() as AddressInfo;
    await use({
      url: `http://127.0.0.1:${address.port}/$discovery/rest?version=v1beta`,
      requests,
      response,
    });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  },
});

for (const scenario of ["not-found", "bad-json", "disconnect"] as const) {
  discoveryTest(
    `reports Google description ${scenario} failures`,
    async ({ provider }) => {
      provider.response.status = scenario === "not-found" ? 404 : 200;
      provider.response.body = "not json";
      provider.response.disconnect = scenario === "disconnect";
      await expect(
        Effect.runPromise(
          scopedGoogleDiscoveryAdapter.fetch({
            urls: [provider.url],
            consentScopes:
              scenario === "bad-json"
                ? ["https://www.googleapis.com/auth/analytics.readonly"]
                : undefined,
            httpClientLayer: FetchHttpClient.layer,
          }),
        ),
      ).rejects.toThrow(
        scenario === "bad-json"
          ? "parse Google Discovery"
          : "Google API description",
      );
      expect(provider.requests[0]).toBe("/$discovery/rest?version=v1beta");
    },
  );
}

discoveryTest(
  "rejects an undeclared Google scope before creating a connection",
  async ({ provider }) => {
    provider.response.body = JSON.stringify({
      discoveryVersion: "v1",
      name: "analyticsdata",
      version: "v1beta",
      rootUrl: "https://analyticsdata.googleapis.com/",
      servicePath: "",
      auth: {
        oauth2: {
          scopes: {
            "https://www.googleapis.com/auth/analytics.readonly": {
              description: "View reports",
            },
          },
        },
      },
      resources: {
        properties: {
          methods: {
            runReport: {
              id: "analyticsdata.properties.runReport",
              path: "v1beta/properties/123:runReport",
              httpMethod: "POST",
              scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
              response: { type: "object" },
            },
          },
        },
      },
    });
    await expect(
      Effect.runPromise(
        scopedGoogleDiscoveryAdapter.fetch({
          urls: [provider.url],
          consentScopes: ["https://www.googleapis.com/auth/analytic.readonly"],
          httpClientLayer: FetchHttpClient.layer,
        }),
      ),
    ).rejects.toThrow("Choose scopes declared in its API description");
  },
);

discoveryTest(
  "preserves preset and refresh permissions absent from the Discovery document",
  async ({ provider }) => {
    provider.response.body = JSON.stringify({
      discoveryVersion: "v1",
      name: "test",
      version: "v1",
      rootUrl: "https://example.invalid/",
      servicePath: "",
      resources: {
        documents: {
          methods: {
            list: {
              id: "test.documents.list",
              path: "documents",
              httpMethod: "GET",
              response: { type: "object" },
            },
          },
        },
      },
    });
    const scopes = ["openid", "https://www.googleapis.com/auth/test.readonly"];
    {
      const converted = await Effect.runPromise(
        googleDiscoveryAdapter.fetch({
          urls: [provider.url],
          consentScopes: scopes,
          httpClientLayer: FetchHttpClient.layer,
        }),
      );
      expect(converted.specText).toContain("test.documents.list");
      expect(converted.authenticationTemplate).toMatchObject([
        { kind: "oauth2", scopes },
      ]);
    }
  },
);
