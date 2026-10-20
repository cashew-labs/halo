import http from "node:http";
import events from "node:events";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { GoogleAppDomainTls } from "./GoogleAppDomainTls.js";

type Resource = {
  state?: string;
  managed?: { state: string };
  dnsResourceRecord?: { name: string; type: string; data: string };
};
const tlsTest = test.extend<{
  cloud: {
    resources: Map<string, Resource>;
    status: number;
    invalid: boolean;
    operationDone: boolean;
    calls: { method: string; path: string }[];
  };
  tls: GoogleAppDomainTls;
}>({
  // oxlint-disable-next-line no-empty-pattern -- Native fixture signature.
  cloud: async ({}, use) =>
    await use({
      resources: new Map(),
      status: 200,
      invalid: false,
      operationDone: true,
      calls: [],
    }),
  tls: async ({ cloud }, use) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url!, "http://cloud.invalid");
      const path = url.pathname.slice("/v1/".length);
      cloud.calls.push({ method: request.method!, path });
      expect(request.headers.authorization).toBe("Bearer test-google-token");
      if (cloud.status !== 200) {
        response.writeHead(cloud.status).end();
        return;
      }
      if (cloud.invalid) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"state":99}');
        return;
      }
      if (path.includes("/operations/")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ done: cloud.operationDone }));
        return;
      }
      if (request.method === "GET") {
        const resource = cloud.resources.get(path);
        response
          .writeHead(resource === undefined ? 404 : 200, {
            "content-type": "application/json",
          })
          .end(JSON.stringify(resource));
        return;
      }
      if (request.method === "DELETE") {
        if (!cloud.resources.has(path)) {
          response.writeHead(404).end();
          return;
        }
        if (cloud.operationDone) cloud.resources.delete(path);
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            name: "projects/test-project/locations/global/operations/delete",
            done: cloud.operationDone,
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const resourceId = [...url.searchParams.values()][0]!;
      if (path.endsWith("dnsAuthorizations"))
        cloud.resources.set(`${path}/${resourceId}`, {
          dnsResourceRecord: {
            name: `_acme-challenge.links.example.org.`,
            type: "CNAME",
            data: "validation.authorize.certificatemanager.goog.",
          },
        });
      else if (path.endsWith("certificates"))
        cloud.resources.set(`${path}/${resourceId}`, {
          managed: { state: "PROVISIONING" },
        });
      else {
        expect(body.hostname).toBe("links.example.org");
        cloud.resources.set(`${path}/${resourceId}`, { state: "ACTIVE" });
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"done":true}');
    });
    server.listen(0, "127.0.0.1");
    await events.once(server, "listening");
    // SAFETY: The numeric TCP listener has started.
    const address = server.address() as AddressInfo;
    await use(
      new GoogleAppDomainTls({
        auth: { getAccessToken: async () => "test-google-token" },
        projectId: "test-project",
        certificateMap: "halo",
        address: "192.0.2.1",
        apiOrigin: `http://127.0.0.1:${address.port}`,
      }),
    );
    server.closeAllConnections();
    server.close();
    await events.once(server, "close");
  },
});
const input = {
  domainId: "cfc1e4e1-4ef1-4a50-9906-f89aa6a9c5e1",
  hostname: "links.example.org",
};
// Durable: activation must wait for both the certificate and its load-balancer map entry.
tlsTest(
  "provisions DNS authorization, a managed certificate, and its map entry idempotently",
  async ({ tls, cloud }) => {
    expect(tls.routingRecords(input.hostname)).toEqual([
      { name: input.hostname, type: "A", value: "192.0.2.1" },
    ]);
    expect(await tls.ensure(input)).toEqual({ ready: false, records: [] });
    const pending = await tls.ensure(input);
    expect(pending).toMatchObject({
      ready: false,
      records: [{ type: "CNAME" }],
    });
    expect(await tls.ensure(input)).toEqual(pending);
    const cert = [...cloud.resources.keys()].find((path) =>
      path.includes("/certificates/"),
    )!;
    cloud.resources.set(cert, { managed: { state: "ACTIVE" } });
    expect(await tls.ensure(input)).toEqual(pending);
    expect(await tls.ensure(input)).toMatchObject({ ready: true });
    const creates = cloud.calls.filter((call) => call.method === "POST");
    expect(creates).toHaveLength(3);
    await tls.remove(input);
    expect(cloud.resources.size).toBe(0);
    await tls.remove(input);
  },
);
tlsTest(
  "fails closed on provider errors and preserves cleanup ordering while a delete is pending",
  async ({ tls, cloud }) => {
    cloud.status = 403;
    expect(await tls.ensure(input)).toBeInstanceOf(Error);
    cloud.status = 200;
    cloud.invalid = true;
    expect(await tls.ensure(input)).toBeInstanceOf(Error);
    cloud.invalid = false;
    await tls.ensure(input);
    await tls.ensure(input);
    cloud.operationDone = false;
    expect(await tls.remove(input)).toBeInstanceOf(Error);
    expect(
      [...cloud.resources.keys()].some((path) =>
        path.includes("/dnsAuthorizations/"),
      ),
    ).toBe(true);
    cloud.operationDone = true;
    await tls.remove(input);
    expect(cloud.resources.size).toBe(0);
  },
);

// Durable: terminal Google failures must not trap a corrected DNS setup forever.
tlsTest(
  "recreates a failed certificate while preserving its DNS authorization",
  async ({ tls, cloud }) => {
    await tls.ensure(input);
    const pending = await tls.ensure(input);
    const certificate = [...cloud.resources.keys()].find((path) =>
      path.includes("/certificates/"),
    )!;
    const authorization = [...cloud.resources.keys()].find((path) =>
      path.includes("/dnsAuthorizations/"),
    )!;
    const proof = cloud.resources.get(authorization);
    cloud.resources.set(certificate, { managed: { state: "ACTIVE" } });
    await tls.ensure(input);
    await tls.ensure(input);
    cloud.resources.set(certificate, { managed: { state: "FAILED" } });
    cloud.operationDone = false;
    expect(await tls.ensure(input)).toBeInstanceOf(Error);
    expect(cloud.resources.has(certificate)).toBe(true);
    cloud.operationDone = true;
    expect(await tls.ensure(input)).toEqual(pending);
    expect(cloud.resources.has(certificate)).toBe(false);
    expect(cloud.resources.get(authorization)).toEqual(proof);
    expect(await tls.ensure(input)).toEqual(pending);
    cloud.resources.set(certificate, { managed: { state: "ACTIVE" } });
    await tls.ensure(input);
    expect(await tls.ensure(input)).toMatchObject({ ready: true });
    expect(
      cloud.calls.filter(
        (call) =>
          call.method === "POST" && call.path.endsWith("dnsAuthorizations"),
      ),
    ).toHaveLength(1);
    expect(
      cloud.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("certificates"),
      ),
    ).toHaveLength(2);
  },
);
