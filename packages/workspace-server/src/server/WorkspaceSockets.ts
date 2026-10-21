import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { RPCHandler } from "@orpc/server/websocket";
import type { HaloContext } from "./router.js";

// Background browser tabs can schedule application timers only once per minute.
const heartbeatDeadline = 90_000;
const maximumLifetime = 55 * 60_000;

type SocketIdentity = {
  clientId: string;
  expiresAt: number;
};

/** Owns RPC sockets and local-development tickets for one workspace. */
export class WorkspaceSockets {
  private readonly tickets = new Map<string, SocketIdentity>();
  private readonly connections = new Map<
    string,
    { socket: WebSocket; lastHeartbeat: number; expiresAt: number }
  >();
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has("halo-rpc") ? "halo-rpc" : false,
  });
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly handler: RPCHandler<HaloContext>;
  private readonly context: HaloContext;

  constructor(ctx: { handler: RPCHandler<HaloContext>; context: HaloContext }) {
    this.handler = ctx.handler;
    this.context = ctx.context;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [ticket, identity] of this.tickets) {
        if (identity.expiresAt <= now) this.tickets.delete(ticket);
      }
      for (const connection of this.connections.values()) {
        if (
          now - connection.lastHeartbeat >= heartbeatDeadline ||
          now >= connection.expiresAt ||
          connection.socket.bufferedAmount > 8 * 1024 * 1024
        )
          connection.socket.terminate();
      }
    }, 5_000);
    this.timer.unref();
  }

  issueTicket(clientId: string) {
    // Superseded attempts need no additional pending ticket for this client.
    for (const [ticket, identity] of this.tickets) {
      if (identity.clientId === clientId || identity.expiresAt <= Date.now())
        this.tickets.delete(ticket);
    }
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.tickets.set(ticket, {
      clientId,
      expiresAt: Date.now() + 60_000,
    });
    return { ticket };
  }

  consumeTicket(request: IncomingMessage) {
    const protocol = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim())
      .find((value) => value.startsWith("halo-ticket."));
    const ticket = protocol?.slice("halo-ticket.".length) ?? "";
    const identity = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (identity === undefined || identity.expiresAt <= Date.now())
      return undefined;
    return { ...identity, expiresAt: Date.now() + maximumLifetime };
  }

  upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    identity: SocketIdentity,
  ) {
    if (socket.destroyed) return;
    this.server.handleUpgrade(request, socket, head, (websocket) => {
      this.connections.get(identity.clientId)?.socket.terminate();
      const connection = {
        socket: websocket,
        lastHeartbeat: Date.now(),
        expiresAt: Math.min(identity.expiresAt, Date.now() + maximumLifetime),
      };
      this.connections.set(identity.clientId, connection);
      this.handler.upgrade(websocket, { context: this.context });
      websocket.on("error", (error) => {
        this.context.logger.warn({ event: "workspace-socket-error", error });
        websocket.terminate();
      });
      websocket.on("message", (data, isBinary) => {
        if (isBinary || data.toString() !== "halo:ping") return;
        connection.lastHeartbeat = Date.now();
        websocket.send("halo:pong");
      });
      websocket.once("close", () => {
        if (this.connections.get(identity.clientId) === connection)
          this.connections.delete(identity.clientId);
      });
    });
  }

  close() {
    clearInterval(this.timer);
    this.tickets.clear();
    for (const connection of this.connections.values())
      connection.socket.terminate();
    this.server.close();
  }
}
