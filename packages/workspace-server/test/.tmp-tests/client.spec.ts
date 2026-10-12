import http from "node:http";
import { expect, test } from "vitest";
import * as errore from "errore";
import {
  createHaloClient,
  connectHaloClient,
  IncompatibleServerError,
  haloProtocolVersion,
} from "@get-halo/client";
import { serverTest } from "../serverTest.js";

serverTest(
  "shared client supports RPC, subscription cancellation, and generation cancellation",
  async ({ server }) => {
    const controller = new AbortController();
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(() => controller.abort());
    const disconnected: Error[] = [];
    const api = createHaloClient({
      transport: server.transport,
      websocket: { clientId: crypto.randomUUID(), signal: controller.signal },
      onDisconnect: (error) => disconnected.push(error),
    });
    const thread = await api.thread.new();
    const cancellation = new AbortController();
    const events = await api.thread.events(thread, {
      signal: cancellation.signal,
    });
    expect((await events.next()).value).toMatchObject({ type: "snapshot" });
    const pending = expect(events.next()).rejects.toThrow();
    cancellation.abort();
    await pending;
    expect(await api.thread.snapshot(thread)).toMatchObject({});
    const denied = createHaloClient({
      transport: server.transport,
      websocket: { clientId: crypto.randomUUID(), signal: controller.signal },
      canRequest: () => false,
    });
    await expect(denied.thread.new()).rejects.toThrow(
      "This action was not sent",
    );
    controller.abort();
    await expect(api.thread.new()).rejects.toThrow();
    expect(disconnected).toEqual([]);
    expect(await server.rpc.thread.list()).toHaveLength(1);
  },
);

test("ticket and upgrade failures reject promptly without replaying requests", async () => {
  await using cleanup = new errore.AsyncDisposableStack();
  let status = 200;
  let body = JSON.stringify({ ticket: "a".repeat(43) });
  let hang = false;
  let requests = 0;
  const gateway = http.createServer((_request, response) => {
    requests++;
    if (!hang)
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(body);
  });
  gateway.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  cleanup.defer(async () => {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });
  const address = gateway.address();
  if (address === null || typeof address === "string")
    throw new Error("missing test listener");
  const transport = {
    origin: `http://127.0.0.1:${address.port}`,
    path: "/rpc",
    headers: {},
  };
  for (const failure of [
    { status: 401, body: "{}", message: "Sign in" },
    { status: 503, body: "{}", message: "HTTP 503" },
    { status: 200, body: "not json", message: "read ticket" },
    { status: 200, body: "{}", message: "invalid ticket" },
    {
      status: 200,
      body: JSON.stringify({ ticket: "a".repeat(43) }),
      message: "open socket",
    },
  ]) {
    status = failure.status;
    body = failure.body;
    const controller = new AbortController();
    cleanup.defer(() => controller.abort());
    const api = createHaloClient({
      transport,
      websocket: { clientId: crypto.randomUUID(), signal: controller.signal },
    });
    await expect(api.server.info()).rejects.toThrow(failure.message);
  }
  const httpDenied = createHaloClient({ transport, canRequest: () => false });
  await expect(httpDenied.server.info()).rejects.toThrow(
    "This action was not sent",
  );
  for (const code of [401, 502, 503, 504]) {
    status = code;
    const plain = createHaloClient({ transport });
    await expect(plain.server.info()).rejects.toThrow(
      code === 401 ? "Sign in" : `HTTP ${code}`,
    );
  }
  hang = true;
  const controller = new AbortController();
  const api = createHaloClient({
    transport,
    websocket: { clientId: crypto.randomUUID(), signal: controller.signal },
  });
  const before = requests;
  const pending = expect(api.server.info()).rejects.toThrow();
  await expect.poll(() => requests).toBe(before + 1);
  controller.abort();
  await pending;
  const refused = createHaloClient({
    transport: { ...transport, origin: "http://127.0.0.1:1" },
    websocket: {
      clientId: crypto.randomUUID(),
      signal: AbortSignal.timeout(1000),
    },
  });
  await expect(refused.server.info()).rejects.toThrow("request ticket");
});

serverTest(
  "WebSocket clients retain HTTP transfers for twenty MiB files",
  async ({ server }) => {
    const controller = new AbortController();
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(() => controller.abort());
    const api = createHaloClient({
      transport: server.transport,
      websocket: { clientId: crypto.randomUUID(), signal: controller.signal },
    });
    await api.server.info();
    const content = "x".repeat(20 * 1024 * 1024);
    await api.workspace.uploadFile({
      path: "large.txt",
      file: new File([content], "large.txt", { type: "text/plain" }),
    });
    expect((await api.workspace.readFile({ path: "large.txt" })).length).toBe(
      content.length,
    );
  },
);

test("an incompatible server without sockets is identified by the initial HTTP probe", async () => {
  await using cleanup = new errore.AsyncDisposableStack();
  const requests: string[] = [];
  const older = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url?.startsWith("/rpc/server/info"))
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            json: {
              protocolVersion: haloProtocolVersion - 1,
              supportedProtocols: [haloProtocolVersion - 1],
            },
          }),
        );
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => older.listen(0, "127.0.0.1", resolve));
  cleanup.defer(async () => {
    older.closeAllConnections();
    await new Promise<void>((resolve) => older.close(() => resolve()));
  });
  const address = older.address();
  if (address === null || typeof address === "string")
    throw new Error("missing listener");
  const controller = new AbortController();
  cleanup.defer(() => controller.abort());
  const result = await connectHaloClient({
    transport: {
      origin: `http://127.0.0.1:${address.port}`,
      path: "/rpc",
      headers: {},
    },
    websocket: { clientId: crypto.randomUUID(), signal: controller.signal },
  });
  expect(result).toBeInstanceOf(IncompatibleServerError);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("/rpc/server/info");
});
