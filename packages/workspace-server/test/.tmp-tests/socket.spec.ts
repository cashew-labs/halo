import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket as NodeSocket } from "ws";
import { expect, vi } from "vitest";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { haloProtocolVersion, type HaloClient } from "@get-halo/client";
import * as errore from "errore";
import { serverTest } from "../serverTest.js";

serverTest(
  "local tickets expire, cancel subscriptions, and close on workspace shutdown",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const transport = server.transport;
    const clientId = crypto.randomUUID();
    const headers = {
      ...transport.headers,
      "x-halo-client-id": clientId,
      origin: "null",
    };
    const endpoint = `${transport.origin}/rpc/connect`;
    const preflight = await fetch(endpoint, {
      method: "OPTIONS",
      headers: { origin: "null" },
    });
    expect(preflight.status).toBe(204);
    expect(
      (await fetch(endpoint, { method: "POST", headers: transport.headers }))
        .status,
    ).toBe(400);
    const issue = async () => {
      const response = await fetch(endpoint, { method: "POST", headers });
      expect(response.status).toBe(200);
      // SAFETY: Successful response from the product ticket endpoint.
      return (await response.json()) as { ticket: string };
    };
    const open = (ticket: string) => {
      const socket = new WebSocket(
        `${transport.origin.replace("http:", "ws:")}/rpc/socket`,
        ["halo-rpc", `halo-ticket.${ticket}`],
      );
      cleanup.defer(() => socket.close());
      const api = createORPCClient<HaloClient>(
        new RPCLink({
          connect: () => socket,
          headers: { "x-halo-protocol-version": String(haloProtocolVersion) },
        }),
      );
      return { socket, api };
    };
    const superseded = await issue();
    const ticket = await issue();
    const rejected = open(superseded.ticket);
    await expect.poll(() => rejected.socket.readyState).toBe(WebSocket.CLOSED);
    const connected = open(ticket.ticket);
    expect(await connected.api.server.info()).toMatchObject({
      protocolVersion: haloProtocolVersion,
    });
    const session = await connected.api.thread.new();
    const cancellation = new AbortController();
    const stream = await connected.api.thread.events(session, {
      signal: cancellation.signal,
    });
    expect((await stream.next()).value).toMatchObject({ type: "snapshot" });
    const pending = expect(stream.next()).rejects.toThrow();
    cancellation.abort();
    await pending;
    expect(await connected.api.thread.snapshot(session)).toMatchObject({});
    const expiring = await issue();
    {
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(Date.now() + 61_000);
      const expired = open(expiring.ticket);
      await expect.poll(() => expired.socket.readyState).toBe(WebSocket.CLOSED);
      await issue();
    }
    await server.stop();
    await expect.poll(() => connected.socket.readyState).toBe(WebSocket.CLOSED);
  },
);

serverTest(
  "renderer tickets and gateway identity guards preserve authentication",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const transport = server.rendererTransport;
    const endpoint = `${transport.origin}/rpc/connect`;
    const headers = {
      ...transport.headers,
      "x-halo-client-id": crypto.randomUUID(),
    };
    expect((await fetch(endpoint, { headers })).status).toBe(400);
    const foreign = await fetch(endpoint, {
      method: "OPTIONS",
      headers: { origin: "https://foreign.invalid" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const response = await fetch(endpoint, { method: "POST", headers });
    expect(response.status).toBe(200);
    // SAFETY: Successful response from the product ticket endpoint.
    const { ticket } = (await response.json()) as { ticket: string };
    const socketUrl = `${transport.origin.replace("http:", "ws:")}/rpc/socket`;
    const first = new NodeSocket(socketUrl, [
      "halo-rpc",
      `halo-ticket.${ticket}`,
    ]);
    cleanup.defer(() => first.terminate());
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });
    for (const options of [
      { protocols: ["halo-rpc", `halo-ticket.${ticket}`], headers: {} },
      { protocols: ["halo-rpc"], headers: transport.headers },
      {
        protocols: ["halo-rpc"],
        headers: { ...headers, "x-halo-session-expires": "invalid" },
      },
      {
        protocols: ["halo-rpc"],
        headers: { ...headers, "x-halo-session-expires": "1" },
      },
    ]) {
      const rejected = new NodeSocket(socketUrl, options.protocols, {
        headers: options.headers,
      });
      cleanup.defer(() => rejected.terminate());
      await expect(
        new Promise<void>((resolve, reject) => {
          rejected.once("open", resolve);
          rejected.once("error", reject);
        }),
      ).rejects.toThrow("401");
    }
  },
);

serverTest(
  "malformed WebSocket frames close the connection without crashing the workspace",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const transport = server.transport;
    const response = await fetch(`${transport.origin}/rpc/connect`, {
      method: "POST",
      headers: {
        ...transport.headers,
        "x-halo-client-id": crypto.randomUUID(),
      },
    });
    // SAFETY: Successful response from the product ticket endpoint.
    const { ticket } = (await response.json()) as { ticket: string };
    const url = new URL(transport.origin);
    const socket = net.connect(Number(url.port), url.hostname);
    cleanup.defer(() => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      [
        "GET /rpc/socket HTTP/1.1",
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Sec-WebSocket-Protocol: halo-rpc, halo-ticket.${ticket}`,
        "",
        "",
      ].join("\r\n"),
    );
    const handshake = await new Promise<Buffer>((resolve) =>
      socket.once("data", resolve),
    );
    expect(handshake.toString()).toContain("101 Switching Protocols");
    const closed = new Promise<void>((resolve) =>
      socket.once("close", resolve),
    );
    // Reserved opcode 3 with a masked empty payload is an invalid client frame.
    socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    await closed;
    expect(
      (
        await fetch(`${transport.origin}/health`, {
          headers: transport.headers,
        })
      ).status,
    ).toBe(200);
  },
);

serverTest(
  "the periodic sweep expires unused tickets and authenticated sessions",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const transport = server.transport;
    const response = await fetch(`${transport.origin}/rpc/connect`, {
      method: "POST",
      headers: {
        ...transport.headers,
        "x-halo-client-id": crypto.randomUUID(),
      },
    });
    // SAFETY: Successful response from the product ticket endpoint.
    const { ticket } = (await response.json()) as { ticket: string };
    const url = `${transport.origin.replace("http:", "ws:")}/rpc/socket`;
    const socket = new NodeSocket(url, ["halo-rpc"], {
      headers: {
        ...transport.headers,
        "x-halo-client-id": crypto.randomUUID(),
        "x-halo-session-expires": String(Date.now() + 30_000),
      },
    });
    cleanup.defer(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(Date.now() + 61_000);
    await delay(5_100);
    expect(socket.readyState).toBe(NodeSocket.CLOSED);
    const expired = new NodeSocket(url, ["halo-rpc", `halo-ticket.${ticket}`]);
    cleanup.defer(() => expired.terminate());
    await expect(
      new Promise<void>((resolve, reject) => {
        expired.once("open", resolve);
        expired.once("error", reject);
      }),
    ).rejects.toThrow("401");
  },
);
