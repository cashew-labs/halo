import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import {
  AuthenticationRequiredError,
  ConnectionHttpError,
} from "./connectionErrors.js";
import type { HaloRpcTransport } from "./createHaloClient.js";

class HaloSocketError extends errore.createTaggedError({
  name: "HaloSocketError",
  message: "Workspace connection failed: $detail",
}) {}

/** One connection attempt; ConnectionService owns retries and snapshot recovery. */
export class HaloSocket {
  private socket: WebSocket | undefined; // coverage-exempt: Playwright Node source-map artifact on a TypeScript field declaration; real socket construction is exercised by client.spec.ts and webHost.e2e.test.ts.
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPong = Date.now();
  private closed = false;
  private readonly signal: AbortSignal;
  private readonly transport: HaloRpcTransport;
  private readonly clientId: string;
  private readonly onDisconnect: ((error: Error) => void) | undefined;

  constructor(ctx: {
    signal: AbortSignal;
    transport: HaloRpcTransport;
    clientId: string;
    onDisconnect?: (error: Error) => void;
  }) {
    this.signal = ctx.signal;
    this.transport = ctx.transport;
    this.clientId = ctx.clientId;
    this.onDisconnect = ctx.onDisconnect;
    this.signal.addEventListener("abort", this.close, { once: true });
  }

  async connect() {
    this.signal.throwIfAborted();
    const response = await fetch(
      new URL(`${this.transport.path}/connect`, this.transport.origin),
      {
        method: "POST",
        headers: {
          ...this.transport.headers,
          "x-halo-client-id": this.clientId,
        },
        signal: this.signal,
      },
    ).catch(
      (cause) => new HaloSocketError({ detail: "request ticket", cause }),
    );
    if (response instanceof Error) throw response;
    if (response.status === 401) throw new AuthenticationRequiredError();
    if (!response.ok)
      throw new ConnectionHttpError({
        service: "workspace",
        stage: "rpc",
        status: response.status,
      });
    const body: unknown = await response
      .json()
      .catch((cause) => new HaloSocketError({ detail: "read ticket", cause }));
    if (body instanceof Error) throw body;
    if (
      !Value.Check(
        Type.Object({
          ticket: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
        }),
        body,
      )
    )
      throw new HaloSocketError({ detail: "invalid ticket" });
    this.signal.throwIfAborted();
    const url = new URL(`${this.transport.path}/socket`, this.transport.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, [
      "halo-rpc",
      `halo-ticket.${body.ticket}`,
    ]);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.closed || this.signal.aborted) {
        // coverage-exempt: Defensive browser open/abort race; cancellation during ticket fetch and live streams is tested through real transports.
        this.close();
        return;
      }
      this.lastPong = Date.now();
      socket.send("halo:ping");
      this.timer = setInterval(() => {
        if (
          Date.now() - this.lastPong >= 90_000 ||
          socket.bufferedAmount > 8 * 1024 * 1024
        ) {
          this.fail(new HaloSocketError({ detail: "heartbeat deadline" }));
          return;
        }
        if (socket.readyState === WebSocket.OPEN) socket.send("halo:ping");
      }, 15_000);
    });
    socket.addEventListener("message", (event) => {
      if (event.data === "halo:pong") this.lastPong = Date.now();
    });
    socket.addEventListener("error", () =>
      this.fail(new HaloSocketError({ detail: "socket error" })),
    );
    socket.addEventListener("close", () =>
      this.fail(new HaloSocketError({ detail: "socket closed" })),
    );
    const opened = await new Promise<WebSocket | HaloSocketError>((resolve) => {
      const finish = (result: WebSocket | HaloSocketError) => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onFailure);
        socket.removeEventListener("close", onFailure);
        this.signal.removeEventListener("abort", onFailure);
        resolve(result);
      };
      const onOpen = () => finish(socket);
      const onFailure = () =>
        finish(
          new HaloSocketError({
            detail: "open socket",
            cause: this.signal.reason,
          }),
        );
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onFailure, { once: true });
      socket.addEventListener("close", onFailure, { once: true });
      this.signal.addEventListener("abort", onFailure, { once: true });
      if (this.signal.aborted) onFailure();
    });
    if (opened instanceof Error) throw opened;
    return opened;
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.close();
    if (!this.signal.aborted) this.onDisconnect?.(error);
  }

  close = () => {
    this.closed = true;
    clearInterval(this.timer);
    this.signal.removeEventListener("abort", this.close);
    this.socket?.close();
  };
}
